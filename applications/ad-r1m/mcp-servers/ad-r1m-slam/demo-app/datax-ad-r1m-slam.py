#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Analog Devices, Inc.
"""
Desktop control panel for SLAM and navigation on the ADI AD-R1M robot.

The robot side is the AD-R1M MCP server one folder up (../server.mjs), driven over stdio
JSON-RPC with the same tools Claude Code uses. Package scoring and diagnosis go through
`claude -p` with the skills' own criteria and fixes. --demo runs on canned data.
"""
import argparse
import json
import os
import queue
import shutil
import subprocess
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
from datetime import datetime
from tkinter import scrolledtext

import design_system as ds
from design_system import (Button, Card, TextField, ThemeMixin, ERROR, INFO, NEUTRAL,
                           PRIMARY, STATUS_COLOR, SUCCESS, WARNING, pick_font,
                           status_text_color)

HERE = os.path.dirname(os.path.abspath(__file__))
SKILLS = os.path.normpath(os.path.join(HERE, "..", "..", "..", "skills"))
TEMPLATES = ("ad-r1m-robot", "templates")  # under SKILLS
LOG_MAX_LINES = 1000

STATUS_FILL = dict(STATUS_COLOR, info=INFO[500])
STATUS_TINT = {
    "light": {"ok": SUCCESS[100], "warn": WARNING[100], "error": ERROR[100],
              "idle": NEUTRAL[200], "info": INFO[100]},
    "dark": {"ok": "#14301F", "warn": "#3A2A08", "error": "#3A1515",
             "idle": NEUTRAL[700], "info": "#152543"},
}


def text_color(theme, key):
    return {"light": INFO[700], "dark": INFO[500]}[theme] if key == "info" else status_text_color(theme, key)


class UI:
    """Density scale: px values go through dp(), point sizes through Tk scaling."""
    scale = 1.0

    @classmethod
    def configure(cls, root, override=None):
        dpi = root.winfo_fpixels("1i") or 96.0
        cls.scale = override or min(2.6, max(1.0, root.winfo_screenheight() / 1000.0 / (dpi / 96.0)))
        for name in ("XS", "SM", "MD", "LG", "XL"):
            setattr(cls, name, cls.dp(getattr(ds, name)))
        root.tk.call("tk", "scaling", dpi / 72.0 * cls.scale)
        ds.XS, ds.SM, ds.MD, ds.RADIUS = cls.XS, cls.SM, cls.MD, cls.dp(ds.RADIUS)

    @classmethod
    def dp(cls, v):
        return max(1, int(round(v * cls.scale)))


# --------------------------------------------------------------------------- backends
class Mcp:
    """Minimal MCP stdio client for ../server.mjs: one request at a time."""

    def __init__(self, server):
        self.proc = subprocess.Popen(["node", server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
        self.n = 0
        self._rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                 "clientInfo": {"name": "datax-ad-r1m-slam", "version": "1.0"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def _rpc(self, method, params):
        self.n += 1
        self._send({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        for line in self.proc.stdout:
            msg = json.loads(line)
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", "MCP error"))
                return msg["result"]
        raise RuntimeError("MCP server exited")

    def call(self, tool, **args):
        res = self._rpc("tools/call", {"name": tool, "arguments": args})
        text = res["content"][0]["text"]
        if res.get("isError"):
            raise RuntimeError(text)
        try:
            return json.loads(text)
        except ValueError:
            return text

    def close(self):
        self.proc.terminate()


class DemoMcp:
    """Canned tool results, so the whole UI runs without a robot."""
    STATUS = {"host": "ad-r1m-demo.local", "state": "ready", "hostname": "ad-r1m-demo",
              "sensors": {"tof": True, "scan": True, "odometry": True},
              "drives": {"healthy": True, "detail": "2 controllers active"},
              "tofClock": {"ok": True, "offsetS": 0, "robotNtp": True}}
    SLAM = {"slamNodes": ["/ab_preprocess", "/rtabmap"], "publishers": {"/map": 1},
            "hz": {"/scan": 10.0, "/cam1/point_cloud": 10.0, "/odometry/filtered": 30.0},
            "tf": {"map->odom": "ok", "odom->base_link": "ok"}, "rtabmap": "cpu_percent=13.3"}
    NAV = {"lifecycle": {n: "active [3]" for n in ("/controller_server", "/planner_server",
                                                     "/behavior_server", "/bt_navigator")}}

    def __init__(self):
        self.slam = self.nav = False

    def call(self, tool, **args):
        res = self._call(tool, **args)
        return dict(res, simulated=True) if isinstance(res, dict) else res

    def _call(self, tool, **args):
        time.sleep(0.4)
        a = args.get("action")
        if tool in ("robot_status", "connect_robot"):
            return dict(self.STATUS, connected=True)
        if tool == "diagnostics":
            if args.get("target") == "nav":
                return self.NAV if self.nav else {"lifecycle": {}}
            return dict(self.SLAM) if self.slam else {"slamNodes": [], "publishers": {"/map": 0}, "hz": {}, "tf": {}}
        if tool == "slam" and a == "deploy":
            return {"deployed": True}
        if tool == "slam":
            self.slam = a == "start"
            return {"started": self.slam, "stopped": not self.slam}
        if tool == "nav":
            self.nav = a != "stop"
            return {"action": a}
        if tool == "package_evidence" and args.get("packages"):
            return {"packages": [{"package": p["name"], "repo": {"url": p["repo"], "rosPackages": {"names": [p["name"]]}}}
                                 for p in args["packages"]]}
        if tool == "package_evidence":
            return {"packages": [{"package": p["package"], "repo": {"url": f"https://github.com/example/{p['package']}"}}
                                 for p in DEMO_SCORES]}
        if tool == "setup_workspace":
            return {"package": args["package"], "ready": True, "containerState": "reused"}
        if tool == "ros2_query" and args.get("kind") == "read_file":
            name = os.path.basename(args["path"])
            if name not in ("launch.py", "image_preprocess.py"):
                raise RuntimeError(f"cat: {args['path']}: No such file or directory")
            return read(*TEMPLATES, "rtabmap_depth_rgb_launch.py" if name == "launch.py" else name)
        return {"ok": True, "tool": tool, **args}

    def close(self):
        pass


DEMO_SCORES = [
    {"package": "rtabmap_ros", "score": 100, "compatible": True, "verdict": "Excellent",
     "reason": "Tested template on this robot; depth + AB image, Humble binaries, Nav2 grid."},
    {"package": "mola_lidar_odometry", "score": 90, "compatible": True, "verdict": "Compatible",
     "reason": "Runs on the ToF cloud as a 3D LiDAR stand-in; narrow FOV caps the verdict."},
    {"package": "slam_toolbox", "score": 95, "compatible": True, "verdict": "Caveats",
     "reason": "Only input is the synthetic /scan from the ToF depth image."},
    {"package": "kiss_icp", "score": 63, "compatible": True, "verdict": "Caveats",
     "reason": "Odometry only, no loop closure; no Humble binary."},
    {"package": "gs_icp_slam", "score": None, "compatible": False, "verdict": "Incompatible",
     "reason": "Needs CUDA; the Raspberry Pi 5 has no GPU."},
]


def ask_claude(prompt, demo=False):
    """One-shot `claude -p` answer, no tools: the prompt carries all the evidence.

    Returns (text, usage); usage counts input, cache write, cache read and output tokens
    and the cost in USD, as `claude -p --output-format json` reports them."""
    if demo:
        time.sleep(0.8)
        names = [p.get("package") for p in json.loads(prompt.split("# Evidence\n", 1)[1]).get("packages", [])] \
            if "# Evidence\n" in prompt and "JSON array" in prompt else []
        scores = DEMO_SCORES + [{"package": n, "score": 60, "compatible": True, "verdict": "Caveats",
                                 "reason": "Demo score: evidence gathered, not evaluated by Claude."}
                                for n in names if n not in {d["package"] for d in DEMO_SCORES}]
        text = (json.dumps(scores) if "JSON array" in prompt else
                "```python\n# Demo: a generated launch file would be here.\nfrom launch import LaunchDescription\n\n\n"
                "def generate_launch_description():\n    return LaunchDescription([])\n```"
                if prompt.startswith("Write a ROS 2") else
                "Demo: no fault found. Robot ready, drives healthy, ToF clock in sync.")
        return text, {"input": len(prompt) // 4, "cache_write": 0, "cache_read": 19800, "output": 380, "cost": 0.04}
    # shutil.which finds claude.cmd / claude.exe on Windows, which a bare "claude" does not.
    r = subprocess.run([shutil.which("claude") or "claude", "-p", "--output-format", "json"], input=prompt,
                       capture_output=True, text=True, encoding="utf-8", timeout=900)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip() or "claude failed")
    d = json.loads(r.stdout)
    u = d.get("usage", {})
    return d["result"], {"input": u.get("input_tokens", 0), "cache_write": u.get("cache_creation_input_tokens", 0),
                         "cache_read": u.get("cache_read_input_tokens", 0), "output": u.get("output_tokens", 0),
                         "cost": d.get("total_cost_usd", 0.0)}


def kilo(n):
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def read(*path):
    """A file of the plugin's skills (skills/)."""
    with open(os.path.join(SKILLS, *path), encoding="utf-8") as f:
        return f.read()


def unscored(name):
    return {"package": name, "score": None, "compatible": True, "verdict": "Not scored",
            "reason": "Claude returned no score for this repository."}


def fill(text, content):
    """Replace the content of a read-only Text."""
    text.configure(state="normal")
    text.delete("1.0", "end")
    text.insert("1.0", content)
    text.configure(state="disabled")


def highlight(buttons, selected):
    """Paint the selected button of a {key: Button} group as primary."""
    for key, b in buttons.items():
        b.variant = "primary" if key == selected else "secondary"
        b.render()


def style_scrollbar(bar, theme, trough):
    bar.configure(bg=theme["scroll_thumb"], troughcolor=theme[trough], bd=0, width=UI.dp(12),
                  highlightthickness=0, relief="flat", elementborderwidth=0)


# --------------------------------------------------------------------------- widgets
class StatusDot(tk.Canvas):
    def __init__(self, master, app, key="idle", size=12):
        self.s = UI.dp(size)
        super().__init__(master, width=self.s, height=self.s, highlightthickness=0, bd=0)
        self.app, self.key = app, key
        app.on_theme(self.render)

    def set(self, key):
        self.key = key
        self.render()

    def render(self):
        s, halo = self.s, STATUS_TINT[self.app.theme_name][self.key]
        self.delete("all")
        self.configure(bg=self.app.parent_bg(self))
        self.create_oval(0, 0, s - 1, s - 1, fill=halo, outline=halo)
        i = s * 0.26
        self.create_oval(i, i, s - 1 - i, s - 1 - i, fill=STATUS_FILL[self.key], outline=STATUS_FILL[self.key])


class StatusBadge(tk.Frame):
    """Dot + label coloured by state."""

    def __init__(self, master, app, text="Not checked", key="idle"):
        super().__init__(master, bd=0, highlightthickness=0)
        self.app, self.key = app, key
        self.dot = StatusDot(self, app, key)
        self.dot.pack(side="left")
        self.label = tk.Label(self, text=text, anchor="w", font=app.font_badge)
        self.label.pack(side="left", padx=(UI.dp(6), 0))
        app.on_theme(self.render)

    def set(self, text, key):
        self.key = key
        self.label.configure(text=text)
        self.render()

    def render(self):
        bg = self.app.parent_bg(self)
        self.configure(bg=bg)
        self.label.configure(bg=bg, fg=text_color(self.app.theme_name, self.key))
        self.dot.set(self.key)


class HeaderButton(Button):
    """Outlined button for the navy header."""

    def render(self):
        bg = self.app.parent_bg(self)
        self.delete("all")
        self.configure(bg=bg)
        fill = PRIMARY[900] if self._pressed else PRIMARY[700] if self._hover else bg
        self.create_polygon(ds.rounded_points(1, 1, self._bw - 1, self._bh - 1, ds.RADIUS),
                            smooth=True, fill=fill, outline=PRIMARY[700], width=UI.dp(1))
        caption = f"{self.icon}  {self.label}" if self.icon else self.label
        self.create_text(self._bw / 2, self._bh / 2, text=caption,
                         fill=NEUTRAL[50] if self._enabled else NEUTRAL[500], font=self.app.font_btn)


class Panel(tk.Frame):
    """Card with a status stripe, title, subtitle and header badge."""

    def __init__(self, parent, app, title, subtitle="", badge=True):
        super().__init__(parent, bd=0, highlightthickness=0)
        self.app, self.accent = app, "idle"
        self.surfaces, self.inks, self.status_inks, self.rules = [], [], [], []
        card = Card(self, app, pad=UI.MD)
        card.outer().pack(fill="both", expand=True)
        body = self.surface(card.body)
        self.stripe = tk.Frame(card, width=UI.dp(3), bd=0)
        self.stripe.pack(side="left", fill="y", before=body)
        head = self.surface(tk.Frame(body))
        head.pack(fill="x")
        titles = self.surface(tk.Frame(head))
        titles.pack(side="left", anchor="w")
        self.ink(tk.Label(titles, text=title, anchor="w", font=app.font_h2)).pack(fill="x")
        self.subtitle = self.ink(tk.Label(titles, text=subtitle, anchor="w", font=app.font_mono), "muted")
        self.subtitle.pack(fill="x", pady=(UI.dp(2), 0))
        self.head_right = self.surface(tk.Frame(head))
        self.head_right.pack(side="right", anchor="ne")
        self.badge = StatusBadge(self.head_right, app) if badge else None
        if self.badge:
            self.badge.pack(anchor="e")
        self.rule = tk.Frame(body, height=UI.dp(1), bd=0)
        self.rule.pack(fill="x", pady=UI.SM)
        self.content = self.surface(tk.Frame(body))
        self.content.pack(fill="both", expand=True)
        app.on_theme(self.render)

    def surface(self, w):
        w.configure(bd=0, highlightthickness=0)
        self.surfaces.append(w)
        return w

    def ink(self, w, token="text"):
        self.inks.append((w, token))
        return w

    def head_button(self, text, command):
        b = Button(self.head_right, self.app, text, command, variant="ghost", height=UI.dp(28))
        b.pack(side="right", padx=(UI.SM, 0))
        return b

    def row(self, label):
        """Caption on the left, a status badge on the right of it."""
        f = self.surface(tk.Frame(self.content))
        f.pack(fill="x", pady=UI.dp(3))
        self.ink(tk.Label(f, text=label, anchor="w", width=16, font=self.app.font_caption), "muted").pack(side="left")
        badge = StatusBadge(f, self.app)
        badge.pack(side="left")
        return badge

    def group(self, title, first=False):
        """Section heading inside the card; later sections get a hairline above them."""
        if not first:
            rule = tk.Frame(self.content, height=UI.dp(1), bd=0)
            rule.pack(fill="x", pady=(UI.MD, 0))
            self.rules.append(rule)
        self.ink(tk.Label(self.content, text=title.upper(), anchor="w", font=self.app.font_caption),
                 "primary").pack(fill="x", pady=(UI.SM if first else UI.MD, UI.XS))

    def buttons(self, specs, caption=None, height=34):
        """A row of buttons that wraps onto more lines when the card is narrow."""
        if caption:
            self.ink(tk.Label(self.content, text=caption, anchor="w", font=self.app.font_small),
                     "muted").pack(fill="x", pady=(UI.SM, 0))
        f = self.surface(tk.Frame(self.content))
        f.pack(fill="x", pady=(UI.XS if caption else UI.SM, 0))
        out = [Button(f, self.app, text, cmd, variant=variant, height=UI.dp(height)) for text, cmd, variant in specs]

        def flow(event):
            x = y = 0
            for b in out:
                w = int(b["width"]) + UI.SM
                if x and x + w > event.width:
                    x, y = 0, y + int(b["height"]) + UI.SM
                b.place(x=x, y=y)
                x += w
            f.configure(height=y + int(out[0]["height"]))
        f.bind("<Configure>", flow)
        f.configure(height=UI.dp(height))
        self.app.actions.extend(out)
        return out

    def set_accent(self, key):
        self.accent = key
        self.stripe.configure(bg=STATUS_FILL[key])

    def render(self):
        t = self.app.theme
        self.configure(bg=t["bg"])
        for w in self.surfaces:
            w.configure(bg=t["card"])
        for w, token in self.inks:
            w.configure(bg=t["card"], fg=t[token])
        for w, key in self.status_inks:
            w.configure(bg=t["card"], fg=text_color(self.app.theme_name, key))
        for w in (self.rule, *self.rules):
            w.configure(bg=t["border"])
        self.set_accent(self.accent)


class Scroll(tk.Frame):
    """A vertically scrolling area: content goes in .inner; the request height stays small."""

    def __init__(self, parent, app):
        super().__init__(parent, bd=0, highlightthickness=0)
        self.app = app
        self.canvas = tk.Canvas(self, bd=0, highlightthickness=0, height=UI.dp(120))
        self.bar = tk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.inner = tk.Frame(self.canvas, bd=0, highlightthickness=0)
        self.win = self.canvas.create_window(0, 0, window=self.inner, anchor="nw")
        self.canvas.configure(yscrollcommand=self.bar.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.bar.pack(side="right", fill="y")
        self.inner.bind("<Configure>", lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(self.win, width=e.width))
        self.bind("<Enter>", lambda e: self._wheel(True))
        self.bind("<Leave>", lambda e: self._wheel(False))
        app.on_theme(self.render)

    def _wheel(self, on):
        for seq, step in (("<Button-4>", -1), ("<Button-5>", 1), ("<MouseWheel>", None)):
            if not on:
                self.unbind_all(seq)
            else:
                self.bind_all(seq, lambda e, s=step: self.canvas.yview_scroll(s or (-1 if e.delta > 0 else 1), "units"))

    def render(self):
        t = self.app.theme
        for w in (self, self.canvas, self.inner):
            w.configure(bg=t["card"])
        style_scrollbar(self.bar, t, "card")


def worst(*keys):
    return next((k for k in ("error", "warn", "ok") if k in keys), "idle")


# --------------------------------------------------------------------------- panels
class RobotPanel(Panel):
    STATES = {"ready": ("Ready", "ok"), "stack_stopped": ("Stack stopped", "warn"),
              "no_stack": ("No AD-R1M software", "warn"), "fresh_kuiper": ("Fresh Kuiper", "warn"),
              "unreachable": ("Unreachable", "error"), "ssh_auth_failed": ("SSH login failed", "error")}

    def __init__(self, parent, app):
        super().__init__(parent, app, "AD-R1M robot", "not connected")
        self.tof, self.scan = self.row("ToF camera"), self.row("Laser scan")
        self.odom, self.drives, self.clock = self.row("Odometry"), self.row("Wheel drives"), self.row("ToF clock")
        self.buttons([("Refresh", app.refresh, "primary"),
                      ("Restart stack", lambda: app.restart("stack"), "secondary"),
                      ("Restart motors", lambda: app.restart("slcan"), "secondary"),
                      ("Restart ToF", lambda: app.restart("tof"), "secondary"),
                      ("Restart RC", lambda: app.restart("crsf"), "secondary")])

    def show(self, st):
        text, key = self.STATES.get(st.get("state"), (st.get("state", "Unknown"), "warn"))
        self.badge.set(text, key)
        self.subtitle.configure(text=st.get("host", ""))
        s, d, c = st.get("sensors", {}), st.get("drives") or {}, st.get("tofClock") or {}
        keys = [key]
        for badge, ok, label in ((self.tof, s.get("tof"), "/cam1 topics"), (self.scan, s.get("scan"), "/scan"),
                                 (self.odom, s.get("odometry"), "/odometry/filtered")):
            badge.set(label if ok else f"No {label}", "ok" if ok else "error")
            keys.append("ok" if ok else "error")
        dk = "ok" if d.get("healthy") else "error" if d else "idle"
        self.drives.set(d.get("detail", "Not checked"), dk)
        ck = {True: "ok", False: "error"}.get(c.get("ok"), "warn" if c else "idle")
        self.clock.set(f"{c['offsetS']} s offset" if "offsetS" in c else c.get("detail", "Not checked"), ck)
        self.set_accent(worst(*keys, dk, ck))


class SlamPanel(Panel):
    TEMPLATES = {"depth_rgb": "Depth + AB", "depth_pointcloud": "Depth + cloud"}

    def __init__(self, parent, app):
        super().__init__(parent, app, "SLAM & navigation", "RTAB-Map, Nav2 and RViz")
        self.template = "depth_rgb"
        nav = lambda action: (lambda: app.run("nav", app.check_slam, action=action))

        self.group("SLAM · RTAB-Map", first=True)
        self.nodes, self.map, self.rates, self.tf = (self.row("Status"), self.row("Map"), self.row("Inputs"),
                                                     self.row("TF map → odom"))
        self.choice = dict(zip(self.TEMPLATES, self.buttons(
            [(label, lambda n=name: self.pick(n), "secondary") for name, label in self.TEMPLATES.items()],
            caption="Template", height=28)))
        self.buttons([("Start", app.start_slam, "primary"),
                      ("Stop", lambda: app.run("slam", app.check_slam, action="stop"), "secondary"),
                      ("Check", app.check_slam, "secondary"),
                      ("Set up", lambda: app.run("setup_workspace", None, package="rtabmap_ros"), "secondary")])

        self.group("Navigation · Nav2")
        self.nav = self.row("Status")
        self.buttons([("Start on /scan", nav("start"), "secondary"),
                      ("Start on point cloud", nav("start_pointcloud"), "secondary"), ("Stop", nav("stop"), "secondary")])

        self.group("Visualization · RViz on this PC")
        self.buttons([("Open RViz", lambda: app.run("rviz", None, action="start"), "secondary"),
                      ("Close RViz", lambda: app.run("rviz", None, action="stop"), "secondary")])
        self.pick(self.template)

    def pick(self, name):
        self.template = name
        highlight(self.choice, name)

    def show(self, slam, nav):
        running = "/rtabmap" in slam.get("slamNodes", [])
        self.nodes.set("Running" if running else "Stopped", "ok" if running else "idle")
        maps = slam.get("publishers", {}).get("/map", 0)
        self.map.set(f"{maps} publisher" if maps else "No /map", "ok" if maps else "idle")
        hz = slam.get("hz", {})
        short = {"/scan": "scan", "/cam1/point_cloud": "cloud", "/odometry/filtered": "odom"}
        self.rates.set(" · ".join(f"{short.get(k, k)} {v:.0f}" for k, v in hz.items()) + " Hz" if hz else "Not measured",
                       "ok" if hz and all(hz.values()) else "warn" if hz else "idle")
        tf = slam.get("tf", {}).get("map->odom")
        self.tf.set(tf or "Not checked", "ok" if tf == "ok" else "error" if tf else "idle")
        states = list(nav.get("lifecycle", {}).values())
        active = bool(states) and all(s.startswith("active") for s in states)
        self.nav.set("Active" if active else "Inactive" if states else "Not running",
                     "ok" if active else "warn" if states else "idle")
        key = "ok" if running and maps and tf == "ok" else "warn" if running else "idle"
        self.badge.set("Mapping" if key == "ok" else "Starting" if running else "Idle", key)
        self.set_accent(key)


class PackagePanel(Panel):
    def __init__(self, parent, app):
        super().__init__(parent, app, "SLAM package evaluation", "package_evidence + EVALUATION_CRITERIA.md")
        self.badge.set("Not evaluated", "idle")
        add = self.surface(tk.Frame(self.content))
        add.pack(fill="x", pady=(0, UI.SM))
        self.ink(tk.Label(add, text="ADD A REPOSITORY", font=app.font_caption), "muted").pack(side="left", padx=(0, UI.SM))
        self.repo = TextField(add, app, "", font=app.font_mono)
        self.repo.pack(side="left", fill="x", expand=True, padx=(0, UI.SM))
        add_repo = lambda _=None: app.evaluate(self.repo.get().strip())
        self.repo.entry.bind("<Return>", add_repo)
        self.add_btn = Button(add, app, "Add", add_repo, variant="secondary", height=UI.dp(30))
        self.add_btn.pack(side="left")
        app.actions.append(self.add_btn)
        self.scroll = Scroll(self.content, app)
        self.scroll.pack(fill="both", expand=True)
        self.table = self.scroll.inner
        self.table.columnconfigure(3, weight=1)
        self.cells, self.row_cells, self.rows, self.selected = [], [], [], None
        self.scroll.canvas.bind("<Configure>", self._wrap, add="+")
        self.buttons([("Evaluate", app.evaluate, "primary"), ("Integrate selected", app.integrate, "secondary")])

    def show(self, rows):
        for w in self.cells:
            w.destroy()
        self.inks = [(w, t) for w, t in self.inks if w not in self.cells]
        self.status_inks, self.cells, self.row_cells, self.rows = [], [], [], rows
        f = self.app
        for c, head in enumerate(("Package", "Score", "Verdict", "Why")):
            self.cells.append(self.ink(tk.Label(self.table, text=head.upper(), anchor="w", font=f.font_caption), "muted"))
            self.cells[-1].grid(row=0, column=c, sticky="w", padx=UI.SM, pady=(0, UI.XS))
        for r, p in enumerate(rows, 1):
            key = "error" if not p.get("compatible", True) else "ok" if (p.get("score") or 0) >= 70 else "warn"
            vals = (p.get("package", "?"), "—" if p.get("score") is None else str(p["score"]),
                    p.get("verdict", ""), p.get("reason", ""))
            for c, v in enumerate(vals):
                lbl = tk.Label(self.table, text=v, anchor="nw", justify="left", cursor="hand2", padx=UI.SM,
                               font=(f.font_mono if c < 2 else f.font_bold if c == 2 else f.font_small),
                               wraplength=UI.dp(200) if c == 3 else 0)
                (self.status_inks.append((lbl, key)) if c == 2 else self.inks.append((lbl, "text2" if c == 3 else "text")))
                lbl.grid(row=r, column=c, sticky="nsew", pady=UI.dp(1), ipady=UI.dp(2))  # no gaps: one bar when selected
                lbl.bind("<Button-1>", lambda e, i=r - 1: self.select(i))
                self.cells.append(lbl)
            self.row_cells.append(self.cells[-4:])
        self.after_idle(self._wrap)
        self.badge.set(f"Best: {rows[0]['package'] if rows else 'none'}", "ok" if rows else "warn")
        self.set_accent("ok" if rows else "warn")
        self.select(0 if rows else None)

    def select(self, i):
        self.selected = i
        self.render()

    def merge(self, rows, name):
        """Add or replace scored rows, keep the table best first, and select `name`."""
        new = {r["package"] for r in rows}
        merged = sorted([r for r in self.rows if r["package"] not in new] + rows,
                        key=lambda r: (r.get("compatible", True), r.get("score") or -1), reverse=True)
        self.show(merged)
        self.select(next((i for i, r in enumerate(merged) if r["package"] == name), None))

    def selection(self):
        return self.rows[self.selected] if self.selected is not None else None

    def render(self):
        super().render()
        if self.selected is not None:
            for w in self.row_cells[self.selected]:
                w.configure(bg=self.app.theme["nav_active_bg"])

    def _wrap(self, _=None):
        """Wrap the reason column to the width left of the table."""
        self.table.update_idletasks()
        width = self.scroll.canvas.winfo_width() - self.table.grid_bbox(column=3, row=0)[0] - 2 * UI.SM
        for cells in self.row_cells:
            cells[3].configure(wraplength=max(UI.dp(120), width))


def theme_text(app, text):
    """Paint a ScrolledText and its scrollbar in the card palette."""
    t = app.theme
    text.configure(bg=t["surface"], fg=t["text"], highlightbackground=t["border"], highlightcolor=t["border"],
                   insertbackground=t["text"], selectbackground=t["primary"], selectforeground=t["on_primary"])
    style_scrollbar(text.vbar, t, "surface")
    text.master.configure(bg=t["card"])


def code_text(parent, app, wrap):
    return scrolledtext.ScrolledText(parent, width=1, height=3, state="disabled", wrap=wrap, font=app.font_mono,
                                     bd=0, relief="flat", highlightthickness=UI.dp(1), padx=UI.SM, pady=UI.XS)


class LogPanel(Panel):
    LEVELS = {"ok": "status", "error": "status", "warn": "status", "info": "text2", "tx": "primary"}

    def __init__(self, parent, app):
        super().__init__(parent, app, "Activity", "MCP tool calls and Claude answers", badge=False)
        self.head_button("Clear", lambda: fill(self.text, ""))
        self.text = code_text(self.content, app, "word")
        self.text.pack(fill="both", expand=True)
        self.text.tag_configure("src", font=app.font_mono_bold)

    def append(self, source, message, level="info"):
        t = self.text
        t.configure(state="normal")
        t.insert("end", datetime.now().strftime("%H:%M:%S  "), "ts")
        t.insert("end", f"{source:<16}", "src")
        t.insert("end", message + "\n", level)
        lines = int(t.index("end-1c").split(".")[0])
        if lines > LOG_MAX_LINES:
            t.delete("1.0", f"{lines - LOG_MAX_LINES + 1}.0")
        t.see("end")
        t.configure(state="disabled")

    def render(self):
        super().render()
        t, name = self.app.theme, self.app.theme_name
        theme_text(self.app, self.text)
        self.text.tag_configure("ts", foreground=t["muted"])
        self.text.tag_configure("src", foreground=t["primary"])
        for level, token in self.LEVELS.items():
            self.text.tag_configure(level, foreground=text_color(name, level) if token == "status" else t[token])


class CodePanel(Panel):
    """The files deployed in the robot's slam_integration package, one tab each."""
    ROOT = "/ros2_ws/src/slam_integration/"
    FILES = ("launch/launch.py", "launch/image_preprocess.py", "launch/cloud_preprocess.py", "config/params.yaml")

    def __init__(self, parent, app):
        super().__init__(parent, app, "Deployed code", self.ROOT, badge=False)
        self.head_button("Copy", self.copy)
        self.deploy_btn = self.head_button("Deploy & start", self.deploy)
        self.head_button("Reload", app.load_code)
        self.tabrow = self.surface(tk.Frame(self.content))
        self.tabrow.pack(fill="x", pady=(0, UI.SM))
        self.text = code_text(self.content, app, "none")
        self.text.pack(fill="both", expand=True)
        self.show({})

    def show(self, files, generated=False):
        """Show files; generated ones (not on the robot yet) can be deployed from here."""
        self.files, self.generated = files, generated
        self.deploy_btn.set_enabled(generated)
        self.subtitle.configure(text="generated by Claude: not deployed yet" if generated else self.ROOT)
        for w in self.tabrow.winfo_children():
            w.destroy()
        self.tabs = {n: Button(self.tabrow, self.app, os.path.basename(n), lambda n=n: self.pick(n),
                               variant="secondary", height=UI.dp(28)) for n in files}
        for b in self.tabs.values():
            b.pack(side="left", padx=(0, UI.SM))
        self.pick(next(iter(files), None))

    def pick(self, name):
        self.current = name
        highlight(self.tabs, name)
        fill(self.text, self.files.get(name, "Nothing loaded yet: Start SLAM, or Reload."))

    def deploy(self):
        if self.generated and "launch.py" in self.files:
            ConfirmDialog(self.app, "Deploy", "Deploy this generated launch.py to the robot's slam_integration "
                          "package and start it? Running SLAM is stopped first.", "Deploy & start",
                          lambda: self.app.deploy(self.files["launch.py"]))

    def copy(self):
        if self.current:
            self.clipboard_clear()
            self.clipboard_append(self.files[self.current])
            self.app.say("Code", f"Copied {self.current} to the clipboard", "info")

    def render(self):
        super().render()
        theme_text(self.app, self.text)


class Dialog(tk.Toplevel):
    """Themed modal dialog: a card-coloured body and a right-aligned button row.

    Replaces tkinter.messagebox, whose internal widget makes focus_get() raise in Button.render."""

    def __init__(self, app, title):
        super().__init__(app)
        self.app, self.labels = app, []
        self.title(title)
        self.transient(app)
        self.body = tk.Frame(self, bd=0)
        self.body.pack(fill="both", expand=True, padx=UI.LG, pady=UI.LG)
        self.bind("<Escape>", lambda e: self.destroy())

    def finish(self, ok_text, ok):
        row = tk.Frame(self.body, bd=0)
        row.pack(fill="x", pady=(UI.LG, 0))
        self.labels.append(row)
        Button(row, self.app, ok_text, ok).pack(side="right")
        Button(row, self.app, "Cancel", self.destroy, variant="secondary").pack(side="right", padx=(0, UI.SM))
        self.bind("<Return>", lambda e: ok())
        self.app.on_theme(self.render)
        self.app.apply_theme()
        self.grab_set()

    def label(self, text, font, muted=False, **kw):
        lbl = tk.Label(self.body, text=text, anchor="w", justify="left", font=font, **kw)
        lbl.muted = muted
        self.labels.append(lbl)
        return lbl

    def render(self):
        t = self.app.theme
        for w in (self, self.body, *self.labels):
            w.configure(bg=t["card"])
            if isinstance(w, tk.Label):
                w.configure(fg=t["muted"] if w.muted else t["text"])


class ConnectDialog(Dialog):
    def __init__(self, app):
        super().__init__(app, "Connect to AD-R1M")
        self.fields = {}
        for name, caption, value in (("host", "Hostname or IP", "ad-r1m-18"), ("user", "User", "analog"),
                                     ("password", "Password", "analog")):
            self.label(caption.upper(), app.font_caption, muted=True).pack(fill="x", pady=(UI.SM, UI.XS))
            self.fields[name] = TextField(self.body, app, value, font=app.font_ui, width=32)
            self.fields[name].pack(fill="x")
        self.fields["password"].entry.configure(show="•")
        self.finish("Connect", self.connect)
        self.fields["host"].focus()

    def connect(self):
        args = {k: f.get().strip() for k, f in self.fields.items()}
        if not args["host"]:
            return self.fields["host"].mark_invalid()
        self.destroy()
        self.app.run("connect_robot", self.app.show_status, **args)


class ConfirmDialog(Dialog):
    def __init__(self, app, title, message, ok_text, on_ok):
        super().__init__(app, title)
        self.label(message, app.font_ui, wraplength=UI.dp(440)).pack(fill="x")
        self.finish(ok_text, lambda: (self.destroy(), on_ok()))


# --------------------------------------------------------------------------- window
class App(tk.Tk, ThemeMixin):
    def __init__(self, args):
        super().__init__()
        self.args, self.actions, self.evidence, self.extra_repos = args, [], {}, {}
        self.title("ADI DataX™ - AD-R1M SLAM")
        UI.configure(self, args.ui_scale)
        self.init_theme(args.theme)
        fam = pick_font("Segoe UI", "Inter", "DejaVu Sans", "Helvetica")
        mono = pick_font("Cascadia Mono", "DejaVu Sans Mono", "Courier")
        F = lambda size, weight="normal", family=fam: tkfont.Font(family=family, size=size, weight=weight)
        self.font_ui, self.font_small, self.font_caption = F(10), F(9), F(8, "bold")
        self.font_bold = self.font_badge = F(10, "bold")
        self.font_h1, self.font_h2 = F(17, "bold"), F(11, "bold")
        self.font_mono, self.font_mono_bold = F(9, family=mono), F(9, "bold", mono)
        try:
            self.attributes("-zoomed", True)
        except tk.TclError:
            self.geometry(f"{self.winfo_screenwidth()}x{self.winfo_screenheight()}")
        self.minsize(UI.dp(1100), UI.dp(700))

        self.jobs, self.results, self._running = queue.Queue(), queue.Queue(), []
        self._build_header()
        self._build_statusbar()
        self._build_content()
        self.bind_all("<Control-r>", lambda e: self.refresh())
        self.bind_all("<F5>", lambda e: self.refresh())
        self.bind_all("<Control-t>", lambda e: self.toggle_theme())
        self.bind_all("<Control-l>", lambda e: fill(self.log.text, ""))
        self.apply_theme()
        self.protocol("WM_DELETE_WINDOW", self._close)

        self.mcp = DemoMcp() if args.demo else None
        threading.Thread(target=self._worker, daemon=True).start()
        self.after(100, self._poll)
        self._tick()
        self.say("Session", "Demo mode — buttons are simulated; run without --demo to drive the robot" if args.demo
                 else f"Live robot via {os.path.relpath(args.server)}", "info")
        self.refresh()

    # ------------------------------------------------------------------ layout
    def _logo(self, height):
        path = next((p for p in (os.path.join(HERE, "assets", n) for n in ("adi_logo@2x.png", "adi_logo.png"))
                     if os.path.exists(p)), None)
        if not path:
            return None
        try:
            from PIL import Image, ImageTk
            im = Image.open(path).convert("RGBA")
            im = im.crop(im.split()[3].getbbox() or (0, 0, im.width, im.height))
            return ImageTk.PhotoImage(im.resize((max(1, round(im.width * height / im.height)), height), Image.LANCZOS))
        except ImportError:
            img = tk.PhotoImage(file=path)
            return img.subsample(max(1, round(img.height() / height)))

    def _build_header(self):
        head = tk.Frame(self, height=UI.dp(76), bd=0)
        head.pack(side="top", fill="x")
        head.pack_propagate(False)
        self._accent = tk.Frame(self, height=UI.dp(3), bd=0)
        self._accent.pack(side="top", fill="x")
        left = tk.Frame(head, bd=0)
        left.pack(side="left", padx=UI.XL)
        self._logo_img = self._logo(UI.dp(30))
        logo = tk.Label(left, image=self._logo_img, bd=0) if self._logo_img else tk.Label(left, text="◆", font=self.font_h1)
        logo.pack(side="left", padx=(0, UI.MD))
        self._rule = tk.Frame(left, width=UI.dp(1), bd=0)
        self._rule.pack(side="left", fill="y", pady=UI.XS, padx=(0, UI.MD))
        titles = tk.Frame(left, bd=0)
        titles.pack(side="left")
        name = tk.Label(titles, text="DataX™ AD-R1M SLAM", font=self.font_h1, anchor="w")
        name.pack(fill="x")
        tagline = tk.Label(titles, text="ToF SLAM and navigation on the AD-R1M robot", font=self.font_ui, anchor="w")
        tagline.pack(fill="x", pady=(UI.dp(3), 0))
        right = tk.Frame(head, bd=0)
        right.pack(side="right", padx=UI.XL)
        summary = tk.Frame(right, bd=0)
        summary.pack(side="left", padx=(0, UI.XL))
        self._robot_dot = StatusDot(summary, self)
        self._robot_dot.pack(side="left")
        self._robot_lbl = tk.Label(summary, text="Not connected", font=self.font_badge)
        self._robot_lbl.pack(side="left", padx=(UI.dp(6), 0))
        self._btns = [HeaderButton(right, self, "Connect", lambda: ConnectDialog(self), height=UI.dp(34)),
                      HeaderButton(right, self, "Refresh", self.refresh, height=UI.dp(34), min_width=UI.dp(116)),
                      HeaderButton(right, self, "Dark", self.toggle_theme, icon="◐", height=UI.dp(34),
                                   min_width=UI.dp(116))]
        for i, b in enumerate(self._btns):
            b.pack(side="left", padx=(UI.SM if i else 0, 0))
        self._head = (head, left, right, titles, summary, logo, name)
        self._tagline = tagline

    def _build_statusbar(self):
        bar = tk.Frame(self, height=UI.dp(30), bd=0)
        bar.pack(side="bottom", fill="x")
        bar.pack_propagate(False)
        self._status_rule = tk.Frame(self, height=UI.dp(1), bd=0)
        self._status_rule.pack(side="bottom", fill="x")
        self._mode_dot = StatusDot(bar, self, "info" if self.args.demo else "ok", size=10)
        self._mode_dot.pack(side="left", padx=(UI.XL, 0))
        self._mode = tk.Label(bar, font=self.font_small,
                              text="Demo mode — synthetic data" if self.args.demo else "Live robot")
        self._mode.pack(side="left", padx=(UI.dp(6), 0))
        self._updated = tk.Label(bar, text="Idle", font=self.font_mono)
        self._updated.pack(side="right", padx=UI.XL)
        self._busy = tk.Label(bar, text="", font=self.font_mono)
        self._busy.pack(side="right")
        self._usage = tk.Label(bar, text="Claude: no calls", font=self.font_mono)
        self._usage.pack(side="right", padx=(0, UI.XL))
        self.usage = {"calls": 0, "tokens": 0, "cost": 0.0}
        self._bar = bar

    def _build_content(self):
        c = tk.Frame(self, bd=0)
        c.pack(side="top", fill="both", expand=True, padx=UI.XL, pady=UI.MD)
        self._content, self._sections = c, []
        for col, w in enumerate((4, 5, 6)):
            c.columnconfigure(col, weight=w, uniform="col")
        c.rowconfigure(3, weight=1, minsize=UI.dp(220))  # the cards keep their height; the rest goes to log and code
        for col, text in enumerate(("Robot", "SLAM & Nav2", "Packages")):
            self._section(c, text, 0, col)
        gap = UI.MD // 2
        self.robot, self.slam, self.packages = RobotPanel(c, self), SlamPanel(c, self), PackagePanel(c, self)
        for col, p in enumerate((self.robot, self.slam, self.packages)):
            p.grid(row=1, column=col, sticky="nsew", padx=(0 if col == 0 else gap, 0 if col == 2 else gap))
        self._section(c, "Activity", 2, 0, top=UI.MD)
        self._section(c, "Code", 2, 2, top=UI.MD)
        self.log = LogPanel(c, self)
        self.log.grid(row=3, column=0, columnspan=2, sticky="nsew", padx=(0, gap))
        self.code = CodePanel(c, self)
        self.code.grid(row=3, column=2, sticky="nsew", padx=(gap, 0))
        self.log.head_button("Ask Claude", self.diagnose)

    def _section(self, parent, text, row, col, top=0):
        lbl = tk.Label(parent, text=text.upper(), anchor="w", font=self.font_caption)
        lbl.grid(row=row, column=col, sticky="w", pady=(top, UI.SM))
        self._sections.append(lbl)

    # ------------------------------------------------------------------ theme
    def apply_theme(self):
        t = self.theme
        self.configure(bg=t["bg"])
        self._btns[2].label, self._btns[2].icon = ("Dark", "◐") if self.theme_name == "light" else ("Light", "◑")
        for w in self._head:
            w.configure(bg=t["header_bg"], **({} if isinstance(w, tk.Frame) or w.cget("image") else {"fg": t["header_fg"]}))
        self._tagline.configure(bg=t["header_bg"], fg=PRIMARY[300])
        self._robot_lbl.configure(bg=t["header_bg"], fg=t["header_fg"])
        self._rule.configure(bg=PRIMARY[700])
        self._accent.configure(bg=PRIMARY[500])
        self._content.configure(bg=t["bg"])
        for w in self._sections:
            w.configure(bg=t["bg"], fg=t["muted"])
        self._bar.configure(bg=t["surface"])
        self._status_rule.configure(bg=t["border"])
        self._mode.configure(bg=t["surface"], fg=t["text2"])
        for w in (self._updated, self._busy, self._usage):
            w.configure(bg=t["surface"], fg=t["muted"])
        super().apply_theme()
        self._rerender(self)  # canvases paint from their parent's bg: repaint once all are themed

    def _rerender(self, w):
        for c in w.winfo_children():
            if isinstance(c, (Button, StatusDot, StatusBadge)):
                c.render()
            if not isinstance(c, (Button, StatusDot)):
                self._rerender(c)

    # ------------------------------------------------------------------ jobs
    def say(self, source, message, level="info"):
        self.log.append(source, message, level)
        self._updated.configure(text=f"Updated {datetime.now():%H:%M:%S}")

    def _worker(self):
        while True:
            label, fn, done = self.jobs.get()
            try:
                if self.mcp is None:
                    self.mcp = Mcp(self.args.server)
                self.results.put((label, done, fn(), None, True))
            except Exception as e:  # reported in the log, never raised into Tk
                self.results.put((label, done, None, e, True))

    def _poll(self):
        try:
            while True:
                label, done, result, err, finished = self.results.get_nowait()
                if finished:
                    self._running.pop(0)
                    self._set_busy()
                if err:
                    self.say(label, str(err).strip().splitlines()[0][:300] if str(err).strip() else repr(err), "error")
                elif done:
                    done(result)
        except queue.Empty:
            pass
        self.after(100, self._poll)

    def _set_busy(self):
        """While a job runs, disable the actions; the status bar shows the oldest job and its elapsed time."""
        for b in self.actions:
            b.set_enabled(not self._running)
        text = ""
        if self._running:
            label, t0 = self._running[0]
            m, sec = divmod(int(time.time() - t0), 60)
            more = f" (+{len(self._running) - 1} queued)" if len(self._running) > 1 else ""
            text = f"{label} running {m}:{sec:02d}{more}   "
        self._busy.configure(text=text)

    def _tick(self):
        if self._running:
            self._set_busy()
        self.after(1000, self._tick)

    def submit(self, label, fn, done=None):
        self._running.append((label, time.time()))
        self._set_busy()
        self.jobs.put((label, fn, done))

    def run(self, tool, then=None, **args):
        """Call an MCP tool on the worker; log it, then hand the result to `then`."""
        def short(k, v):
            if k == "password":
                return "•••"
            if isinstance(v, dict):
                return "{" + ", ".join(v) + "}"
            v = str(v)
            return v if len(v) <= 60 and "\n" not in v else f"<{len(v)} chars>"
        shown = ", ".join(f"{k}={short(k, v)}" for k, v in args.items())
        self.say(tool, f"→ {tool}({shown})", "tx")

        def done(res):
            self.say(tool, summarize(res), "ok")
            if then:
                then(res)
        self.submit(tool, lambda: self.mcp.call(tool, **args), done)

    # ------------------------------------------------------------------ actions
    def refresh(self, _=None):
        self.run("robot_status", self.show_status)

    def show_status(self, st):
        if not isinstance(st, dict):
            return
        text, key = RobotPanel.STATES.get(st.get("state"), ("Unknown", "warn"))
        self._robot_dot.set(key)
        self._robot_lbl.configure(text=f"{st.get('hostname') or st.get('host', '')} · {text}")
        if "sensors" in st:
            self.robot.show(st)
        else:  # connect_robot: state only, the sensor rows come from robot_status
            self.robot.badge.set(text, key)
            self.robot.subtitle.configure(text=st.get("host", ""))
            if key != "error":
                self.refresh()

    def restart(self, target):
        what = {"stack": "the robot stack (compose down, then ad-r1m-bringup)",
                "slcan": "the wheel drives and CAN bus (ad-r1m-slcan) with the stack",
                "tof": "the ToF camera clock and node (ad-r1m-tof) with the stack",
                "crsf": "the RC receiver (ad-r1m-crsf) with the stack"}[target]
        ConfirmDialog(self, "Restart", f"Restart {what}?\n\nRunning SLAM and Nav2 lose their inputs while it runs.",
                      "Restart", lambda: self.run("restart", self.refresh, target=target))

    def start_slam(self, template=None):
        self.run("slam", lambda _: (self.check_slam(), self.load_code()), action="start",
                 template=template or self.slam.template)

    def load_code(self, _=None):
        self.say("ros2_query", f"→ read_file {CodePanel.ROOT}: launch, preprocessing, params", "tx")

        def job():
            files = {}
            for f in CodePanel.FILES:
                try:
                    files[f] = self.mcp.call("ros2_query", kind="read_file", path=CodePanel.ROOT + f)
                except RuntimeError:  # not deployed with this template
                    pass
            return files

        def done(files):
            self.code.show(files)
            self.say("ros2_query", f"{len(files)} files deployed" if files else "No slam_integration files",
                     "ok" if files else "warn")
        self.submit("ros2_query", job, done)

    def claude(self, label, prompt):
        """ask_claude on the worker; the usage is logged and totalled on the Tk thread."""
        text, u = ask_claude(prompt, self.args.demo)
        self.results.put((label, self._track, u, None, False))  # an update, not the end of the job
        return text

    def _track(self, u):
        total = u["input"] + u["cache_write"] + u["cache_read"] + u["output"]
        self.usage = {"calls": self.usage["calls"] + 1, "tokens": self.usage["tokens"] + total,
                      "cost": self.usage["cost"] + u["cost"]}
        self.say("Claude", f"{kilo(u['input'] + u['cache_write'] + u['cache_read'])} in "
                 f"({kilo(u['cache_read'])} cached) · {kilo(u['output'])} out · ${u['cost']:.3f}", "info")
        c = self.usage
        self._usage.configure(text=f"Claude: {c['calls']} call{'s' * (c['calls'] != 1)} · "
                                   f"{kilo(c['tokens'])} tokens · ${c['cost']:.2f}")

    def check_slam(self, _=None):
        self.say("diagnostics", "→ diagnostics(target=slam), diagnostics(target=nav)", "tx")

        def done(res):
            self.slam.show(*res)
            self.say("diagnostics", f"{self.slam.badge.label['text']}, Nav2 {self.slam.nav.label['text'].lower()}", "ok")
        self.submit("diagnostics", lambda: [self.mcp.call("diagnostics", target=t) for t in ("slam", "nav")], done)

    def evaluate(self, url=None):
        """Score the catalog and the added repositories, or add and score the repository at `url`."""
        name = url and url.rstrip("/").split("/")[-1].replace(".git", "")
        if url is not None and not (url.startswith(("https://", "http://", "git@")) and name):
            self.packages.repo.mark_invalid()
            return self.say("evaluate", "Enter a git URL, e.g. https://github.com/org/repo", "warn")
        extra = [{"name": name, "repo": url}] if url else [{"name": n, "repo": u} for n, u in self.extra_repos.items()]
        self.say("evaluate", f"→ package_evidence ({url or 'catalog' + (f' + {len(extra)} added' if extra else '')}), "
                             "then claude -p with EVALUATION_CRITERIA.md", "tx")

        def job():
            evidence = self.mcp.call("package_evidence", **({"packages": extra} if url else {}))
            if extra and not url:
                evidence["packages"] += self.mcp.call("package_evidence", packages=extra)["packages"]
            answer = self.claude("evaluate", (
                "Score these ROS 2 SLAM packages for the AD-R1M with the criteria below. Use only this "
                "text, no tools. Reply with only a JSON array, best first, of objects "
                '{"package", "score" (0-100, null if incompatible), "compatible", "verdict" (<= 3 words), '
                '"reason" (one sentence citing the evidence)}.\n\n# Criteria\n'
                + read("ad-r1m-slam-integration", "EVALUATION_CRITERIA.md") + "\n\n# Evidence\n" + json.dumps(evidence)))
            return json.loads(answer[answer.index("["):answer.rindex("]") + 1]), evidence["packages"]

        def done(res):
            rows, found = res
            self.evidence.update({p["package"]: p for p in found})
            if url:  # package_evidence may return a catalog alias (ORB_SLAM3_ROS2 -> orb_slam3_ros2)
                key = found[0]["package"] if found else name
                self.extra_repos[key] = url
                rows = [r for r in rows if r.get("package") == key]
            scored = {r.get("package") for r in rows}
            rows += [unscored(n) for n in ([key] if url else self.extra_repos) if n not in scored]
            if url:
                self.packages.merge(rows, key)
                self.packages.repo.set("")
            else:
                self.packages.show(rows)
            best = rows[0] if rows else {}
            self.say("evaluate", f"{len(rows)} scored, best {best.get('package')}: {best.get('score')} "
                                 f"{best.get('verdict')} — {best.get('reason', '')}", "ok")
        self.submit("evaluate", job, done)

    def integrate(self):
        """setup_workspace for the selected package, then its tested template or a generated launch file."""
        p = self.packages.selection()
        if not p:
            return self.say("integrate", "Evaluate, then select a package in the table", "warn")
        name = p["package"]
        if not p.get("compatible", True):
            return self.say("integrate", f"{name} is incompatible with the AD-R1M: {p.get('reason', '')}", "warn")
        key = name  # evidence and table key; `name` may become the repo's ROS package below
        repo_info = (self.evidence.get(key) or {}).get("repo") or {}
        repo = repo_info.get("url", "")
        # A repository's ROS package can be named differently (ORB_SLAM3_ROS2 ships orbslam3).
        ros = (repo_info.get("rosPackages") or {}).get("names") or []
        if ros and name not in ros:
            name = next((n for n in ros if name.lower().replace("-", "_") in n.lower()), ros[0])

        def after_setup(res):
            if not isinstance(res, dict) or not res.get("ready"):
                return self.say("integrate", f"{name} is not installed: {summarize(res)}", "warn")
            if name == "rtabmap_ros":
                self.start_slam()
            elif name == "mola_lidar_odometry":
                self.deploy(read(*TEMPLATES, "mola_icp_launch.py"))
            else:
                self.generate(name, key)
        self.run("setup_workspace", after_setup, package=name, **({"repo": repo} if repo else {}))

    def deploy(self, launch):
        """Deploy a launch file (with the AB preprocessing helper) and start it."""
        self.run("slam", lambda _: self.start_slam("deployed"), action="deploy", launch_file=launch,
                 helpers={"image_preprocess.py": read(*TEMPLATES, "image_preprocess.py")})

    def generate(self, name, key=None):
        self.say("Claude", f"→ write launch.py for {name} with the ad-r1m-slam-integration skill", "tx")
        evidence = self.evidence.get(key or name, {})

        def job():
            topics = self.mcp.call("ros2_query", kind="topics")
            prompt = (f"Write a ROS 2 Humble launch.py that runs the SLAM package {name} on the AD-R1M, following "
                      "the integration skill below. Use the robot's real topics, the package's real node names and "
                      "parameters, and the tested template as the model for remappings. image_preprocess.py is "
                      "deployed next to it (get_package_share_directory('slam_integration')/launch). Never flip or "
                      "rotate the ToF data. Use only this text, no tools. Reply with only the file in one ```python "
                      "block.\n\n# Skill\n" + read("ad-r1m-slam-integration", "SKILL.md")
                      + "\n\n# Robot\n" + read("ad-r1m-robot", "ROBOT_SPEC.md")
                      + "\n\n# Tested template\n" + read(*TEMPLATES, "rtabmap_depth_rgb_launch.py")
                      + "\n\n# Live topics\n" + str(topics) + "\n\n# Evidence\n" + json.dumps(evidence)[:20000])
            answer = self.claude("Claude", prompt)
            code = answer.split("```python", 1)[-1].split("```", 1)[0] if "```" in answer else answer
            return code.strip() + "\n"

        def done(code):
            self.code.show({"launch.py": code}, generated=True)
            self.say("Claude", f"launch.py for {name} generated: review it in Code, then Deploy & start", "ok")
        self.submit("Claude", job, done)

    def diagnose(self):
        self.say("Claude", "→ robot status + SLAM/Nav2 diagnostics, with COMMON_FIXES.md", "tx")
        recent = self.log.text.get("end-60l", "end")  # read here: Tk is not thread-safe

        def job():
            facts = {"robot_status": self.mcp.call("robot_status"),
                     "slam": self.mcp.call("diagnostics", target="slam"),
                     "nav": self.mcp.call("diagnostics", target="nav"), "recent_log": recent}
            return self.claude("Claude", "You troubleshoot an AD-R1M robot. Use only this text, no tools. In at most 6 short "
                              "lines: what is wrong (or 'no fault'), then the fix as MCP tool calls.\n\n# Known "
                              "fixes\n" + read("ad-r1m-robot", "COMMON_FIXES.md")
                              + "\n\n# Facts\n" + json.dumps(facts, default=str))

        def done(answer):
            for line in answer.strip().splitlines():
                if line.strip():
                    self.say("Claude", line.strip(), "info")
        self.submit("Claude", job, done)

    def _close(self):
        if self.mcp:
            self.mcp.close()
        self.destroy()


def summarize(res):
    """One log line per tool result: the fields that say what happened."""
    if not isinstance(res, dict):
        return str(res).strip().splitlines()[0][:200] if str(res).strip() else "done"
    keys = ("state", "connected", "started", "stopped", "running", "action", "target", "ready", "bringup",
            "not_restarted", "deployed", "detail", "ttyCRSF", "skipped", "containerState")
    parts = [f"{k}={res[k]}" for k in keys if k in res and res[k] not in ("", None)]
    if "running" in res and "log" in res:  # rviz
        parts.append(f"log {res['log']}")
    if isinstance(res.get("drives"), dict):
        parts.append(f"drives={'healthy' if res['drives'].get('healthy') else res['drives'].get('detail')}")
    if isinstance(res.get("tofClock"), dict) and "offsetS" in res["tofClock"]:
        parts.append(f"tofClock={res['tofClock']['offsetS']} s")
    if res.get("simulated"):
        parts.append("simulated (demo, nothing sent)")
    return "  ".join(parts) or "done"


def main():
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument("--demo", action="store_true", help="canned data, no robot or Claude needed")
    p.add_argument("--theme", choices=("light", "dark"), default="light")
    p.add_argument("--ui-scale", type=float, help="override the UI density factor")
    p.add_argument("--server", default=os.path.join(HERE, "..", "server.mjs"), help="AD-R1M MCP server")
    App(p.parse_args()).mainloop()


if __name__ == "__main__":
    main()
