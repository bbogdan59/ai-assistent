"""
One-time local helper to obtain a Google OAuth2 refresh token for a personal
Google account, so the deployed bot can call the Calendar API unattended.

Run with: python scripts/get_google_token.py

Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in your local .env (create
an OAuth Client of type "Desktop app" in Google Cloud Console).
"""

import os
import sys

from dotenv import load_dotenv
from google_auth_oauthlib.flow import InstalledAppFlow

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/calendar"]
PORT = 53682

client_id = os.environ.get("GOOGLE_CLIENT_ID")
client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")

if not client_id or not client_secret:
    print("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env before running this script.")
    sys.exit(1)

client_config = {
    "installed": {
        "client_id": client_id,
        "client_secret": client_secret,
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "redirect_uris": [f"http://localhost:{PORT}/"],
    }
}

flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)

print(
    "\nA browser tab will open (or a URL will be printed below) - log in with the "
    "Google account that has access to the calendar(s) you want the bot to use, "
    "and approve access.\n"
)

credentials = flow.run_local_server(port=PORT, access_type="offline", prompt="consent")

print("\nAdd this to your .env / Railway environment variables:\n")
print(f"GOOGLE_REFRESH_TOKEN={credentials.refresh_token}\n")
