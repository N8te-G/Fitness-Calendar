"""Settings read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from datetime import datetime, tzinfo
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    timezone: tzinfo
    # Days of history kept warm in the local cache. Baselines use the 28 days
    # before the day being assessed, so this needs some headroom.
    history_days: int = 45

    @property
    def db_path(self) -> Path:
        return self.data_dir / "health.sqlite3"

    @property
    def token_path(self) -> Path:
        return self.data_dir / "garmin_tokens.json"


def load_settings() -> Settings:
    data_dir = Path(os.getenv("GARMIN_HEALTH_DATA_DIR", "~/.garmin-health")).expanduser()
    data_dir.mkdir(parents=True, exist_ok=True)
    tz_name = os.getenv("GARMIN_HEALTH_TZ")
    # "Today" must be your local day, not the server's, or the morning brief
    # looks at the wrong night when the server runs in another timezone.
    tz = ZoneInfo(tz_name) if tz_name else datetime.now().astimezone().tzinfo
    history = int(os.getenv("GARMIN_HEALTH_HISTORY_DAYS", "45"))
    return Settings(data_dir=data_dir, timezone=tz, history_days=history)
