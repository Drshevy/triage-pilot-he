talkinghead.bundle.mjs = esbuild bundle (ESM, minified) of:
  - @met4citizen/talkinghead 1.8.2 (MIT, Copyright (c) Mika Suominen) — https://github.com/met4citizen/TalkingHead
  - three.js r186 + addons (MIT, Copyright 2010-2025 three.js authors)
  - fflate (MIT), meshoptimizer decoder (MIT) — license comments preserved at end of bundle
Built with: npx esbuild entry.mjs --bundle --format=esm --minify --legal-comments=eof
No network access at runtime: TalkingHead's cloud TTS (speakText) and lipsync modules are NOT used;
the app drives visemes itself (js/visemes.js, js/speaker.js) via the morph-target "realtime" channel.
