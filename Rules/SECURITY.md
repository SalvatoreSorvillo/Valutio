# Security

Valutio is local-first. The app stores user-entered finance data in the browser on the user's device and does not provide accounts, server storage or bank connections.

## Reporting a vulnerability

Please report security issues privately by emailing:

support@valutio.app

Include:

- A clear description of the issue.
- Steps to reproduce it.
- The browser and operating system used.
- Any impact you can confirm.

Please do not include real financial data in reports. Use a test profile or sample data.

## Data protection model

- Browser storage is sandboxed to the site but is not encrypted by Valutio itself.
- Password-protected backup exports are encrypted with AES-256-GCM through the browser Web Crypto API.
- There is no backup password recovery.
- Live market and FX refreshes can contact third-party providers for the requested symbols/rates.
