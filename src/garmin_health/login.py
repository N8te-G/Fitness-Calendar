"""One-time Garmin sign-in: saves login tokens and downloads your history.

Run this on your own computer (Garmin sometimes blocks sign-ins from cloud
servers). Your password is used once and never stored; only the tokens
Garmin issues are saved, in the data folder.
"""

from __future__ import annotations

import getpass
import logging

from garminconnect import Garmin

from .config import load_settings
from .service import HealthService


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    settings = load_settings()
    email = input("Garmin Connect email: ").strip()
    password = getpass.getpass("Garmin Connect password: ")
    api = Garmin(email, password, prompt_mfa=lambda: input("Garmin MFA code: ").strip())
    api.login(str(settings.token_path))
    print(f"Signed in as {api.full_name or api.display_name}. Tokens saved to {settings.token_path}")

    print(f"Downloading the last {settings.history_days} days (takes a minute or two)...")
    result = HealthService(settings).sync()
    print(f"Done: {result['fetched_days']} days cached.", *result["errors"], sep="\n")


if __name__ == "__main__":
    main()
