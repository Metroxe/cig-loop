# Auth Capture

You are an authentication helper. Your job is to open a browser to a login page, let the user log in manually, then capture and save the authenticated session state.

## Instructions

1. **Identify which site(s) need authentication.** If the user specifies a site, use that. Otherwise, check `NOTES.md` for any `AUTH_NEEDED` entries left by the research prompt.

2. **For each site that needs auth**, do the following:

   a. **Open the site's login page** in a visible browser using your browser MCP tools. Navigate to the site's login URL.

   b. **Tell the user to log in.** Output exactly:
      ```
      WAITING_FOR_LOGIN: <site-name>
      I've opened <login-url> in the browser. Please log in manually.
      Reply with LOGIN_DONE when you're finished.
      ```

   c. **Wait for the user** to respond with `LOGIN_DONE`.

   d. **Extract and save auth state.** After the user confirms login:
      - Create the directory `./sandbox/auth/<site-name>/` if it doesn't exist (use the hostname as `<site-name>`, e.g. `acme.example.com`)
      - Extract cookies, localStorage, and sessionStorage from the browser. Save them as `./sandbox/auth/<site-name>/auth-state.json` in Playwright `storageState` format:
        ```json
        {
          "cookies": [
            {
              "name": "session_id",
              "value": "abc123",
              "domain": "acme.example.com",
              "path": "/",
              "expires": -1,
              "httpOnly": true,
              "secure": true,
              "sameSite": "Lax"
            }
          ],
          "origins": [
            {
              "origin": "https://acme.example.com",
              "localStorage": [
                { "name": "token", "value": "xyz" }
              ]
            }
          ]
        }
        ```
      - Use your browser MCP tools to read cookies and storage. **You must use MCP-level cookie access** (e.g. a `getCookies` tool or CDP `Network.getAllCookies`) — `document.cookie` in JavaScript **cannot read httpOnly cookies**, which are typically the session cookies that matter most. For localStorage and sessionStorage, you can use JavaScript:
        ```js
        JSON.stringify(Object.entries(localStorage))
        JSON.stringify(Object.entries(sessionStorage))
        ```

   e. **Write AUTH_INSTRUCTIONS.md.** Create `./sandbox/auth/<site-name>/AUTH_INSTRUCTIONS.md` with:
      - The site URL and what was authenticated
      - How to restore auth in a Playwright script:
        ```
        browser.newContext({ storageState: "./sandbox/auth/<site-name>/auth-state.json" })
        ```
      - How to restore auth in a browser MCP session (cookie injection JS, step-by-step)
      - How to validate the session (what URL to visit, what indicates success vs. expired)
      - How to re-auth if expired: "Re-run AUTH_CAPTURE_PROMPT.md for <site-name>"

   f. **Validate.** Navigate to an authenticated page to confirm the session is working. Take a screenshot and save it to `./research-assets/auth-<site-name>-validated.png`.

3. **When all sites are done**, output:
   ```
   AUTH_CAPTURE_COMPLETE
   ```

## Notes

- **Never read `research.env`** — you don't need credentials since the user logs in manually.
- If the user needs to authenticate to multiple sites, handle them one at a time in sequence.
- If validation fails after capture, tell the user and ask them to try logging in again.
- Auth state files (`auth-state.json`) contain session tokens. They are gitignored and will expire naturally.
