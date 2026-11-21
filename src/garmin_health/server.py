"""MCP server exposing your Garmin health data and assessments to Claude."""

from __future__ import annotations

import argparse
import logging
import os
import functools
import sys
from typing import Any, Callable

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from .config import load_settings
from .service import HealthService

INSTRUCTIONS = """\
Personal Garmin health assistant for one person. All numbers come from their
own Garmin watch and are compared with THEIR normal (a 28-day personal
baseline), not population ranges. This is an early "you're off your normal"
nudge, not medical advice; say so briefly if they ask about symptoms, and
suggest a doctor for anything serious or persistent.

Morning brief (tool: morning_brief) — keep it short and phone-friendly:
1. One-line status: Fine / Tired / Getting sick / Sick, with the main reason.
2. Key vitals vs baseline: HRV, resting HR, sleep, respiration, SpO2 (where
   present): value, their normal, and an arrow or % change. Mark the flagged ones.
3. How hard to train today (use the `training` field).
4. If last_night_synced is false, say last night hasn't synced yet and to open
   the Garmin Connect app, then try again.
5. End by asking: "How do you feel? (fine / tired / getting sick / sick)".
   Skip this if checkin_already_logged is set.

Night check (tool: night_check): tomorrow's outlook in one line, the warnings,
and 2-3 concrete tips for tonight. End with the same "how do you feel?" question
unless a check-in is already logged for today.

When they answer how they feel, call log_check_in straight away (map their
words to fine / tired / getting_sick / sick and keep any symptoms as notes).
These check-ins are how the assessments get personalised over time.
Report the model's numbers as given; don't invent values that aren't returned.
"""


def _friendly(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Pass expected problems (not signed in, bad input) through to Claude."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except (RuntimeError, ValueError) as e:
            raise ToolError(str(e)) from e

    return wrapper


def build_server(service: HealthService) -> MCPServer:
    mcp = MCPServer("garmin-health", instructions=INSTRUCTIONS)

    @mcp.tool()
    @_friendly
    def morning_brief(date: str | None = None) -> dict[str, Any]:
        """Morning check: last night's vitals vs your personal baseline, a
        fine / tired / getting_sick / sick status with reasons, and how hard to
        train today. `date` is YYYY-MM-DD and defaults to today."""
        return service.morning_brief(date)

    @mcp.tool()
    @_friendly
    def night_check(date: str | None = None) -> dict[str, Any]:
        """Evening check: uses today's daytime stress, Body Battery, training
        load and the last few nights to warn if you're likely to be off
        tomorrow. `date` defaults to today."""
        return service.night_check(date)

    @mcp.tool()
    @_friendly
    def log_check_in(feeling: str, notes: str | None = None, date: str | None = None) -> dict[str, Any]:
        """Record how you actually feel: one of fine, tired, getting_sick,
        sick. Optional notes (symptoms, context like travel or alcohol).
        Used to learn which of your patterns really mean you're getting sick."""
        return service.log_check_in(feeling, notes, date)

    @mcp.tool()
    @_friendly
    def get_vitals(days: int = 14, end_date: str | None = None) -> dict[str, Any]:
        """Daily HRV, resting HR, sleep, respiration, SpO2, stress, Body
        Battery, steps and training load for the last `days` days (max 30),
        each with your baseline and how far off it is."""
        return service.vitals(min(max(days, 1), 30), end_date)

    @mcp.tool()
    @_friendly
    def get_recent_activities(days: int = 7) -> dict[str, Any]:
        """Workouts from the last `days` days (max 30): type, duration,
        distance, heart rate, training load and training effect."""
        return service.activities(min(max(days, 1), 30))

    @mcp.tool()
    @_friendly
    def get_learning_summary() -> dict[str, Any]:
        """What has been learned from your check-ins: per-marker weights,
        which markers actually move before you get sick, and how often the
        morning status has matched how you felt."""
        return service.learning_summary()

    @mcp.tool()
    @_friendly
    def refresh_garmin_data(days: int = 7) -> dict[str, Any]:
        """Force a re-download of the last `days` days from Garmin Connect
        (use after syncing the watch if numbers look stale)."""
        return service.sync(days=min(max(days, 1), 60), force_recent=True)

    @mcp.prompt()
    def morning() -> str:
        """Run my morning brief."""
        return "Give me my morning brief."

    @mcp.prompt()
    def night() -> str:
        """Run my night check."""
        return "Do my night check for tomorrow."

    return mcp


def main() -> None:
    parser = argparse.ArgumentParser(description="Garmin health MCP server")
    parser.add_argument("--http", action="store_true", help="serve over HTTP (for Claude custom connectors)")
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8000")))
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    service = HealthService(load_settings())
    server = build_server(service)

    if not args.http:
        server.run("stdio")
        return

    # The connector URL is the only thing guarding your data, so outside
    # localhost it must contain a long random secret.
    secret = os.getenv("MCP_SECRET", "")
    local = args.host in ("127.0.0.1", "localhost", "::1")
    if not local and len(secret) < 24:
        sys.exit("Set MCP_SECRET to a random string of 24+ characters before serving publicly "
                 "(e.g. `python -c 'import secrets; print(secrets.token_urlsafe(32))'`).")
    path = f"/{secret}/mcp" if secret else "/mcp"
    logging.info("Serving MCP on http://%s:%s/<secret>/mcp", args.host, args.port)
    server.run("streamable-http", host=args.host, port=args.port, streamable_http_path=path, stateless_http=True)


if __name__ == "__main__":
    main()
