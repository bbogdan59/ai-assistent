/**
 * One-time local helper to obtain a Google OAuth2 refresh token for a
 * personal Google account, so the deployed bot can call the Calendar API
 * unattended. Run with: npm run auth:google
 *
 * Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in your local .env
 * (create an OAuth Client of type "Desktop app" in Google Cloud Console).
 */
import "dotenv/config";
import http from "http";
import { google } from "googleapis";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env before running this script.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/calendar"],
});

console.log("\nOpen this URL in a browser, log in with the Google account that has access\nto the calendar(s) you want the bot to use, and approve access:\n");
console.log(authUrl + "\n");

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/oauth2callback")) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing ?code in callback URL");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Success - you can close this tab and return to the terminal.");

    console.log("\nAdd this to your .env / Railway environment variables:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Token exchange failed - see terminal for details.");
    console.error("Token exchange failed:", err);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 250);
  }
});

server.listen(PORT, () => {
  console.log(`Waiting for the OAuth redirect on ${REDIRECT_URI} ...`);
});
