Royale Lite - Prototype
-----------------------

Files:
- server.js
- package.json
- users.json
- public/index.html
- public/client.js
- public/style.css

How to run locally:
1. Install Node.js (v16+).
2. In project root run:
   npm install
   npm start
3. Open http://localhost:3000 in browsers. Sign up, sign in, join queue.

Deploy on Replit:
- Create a new Repl (Node.js), upload these files, run `npm install`, then `npm start`.
- Replit will give you a public URL you can share.

Notes:
- Passwords are hashed with SHA256 + simple salt (prototype only) and stored in users.json.
- Users and stats persist in users.json (file-system). On Replit this persists across runs.
- This is a prototype; do not use in production without improving security.

