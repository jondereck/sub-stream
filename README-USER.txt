KAMI SUBS - SIMPLE EDGE SETUP

WHAT THIS DOES
- Adds live translated subtitles to browser videos
- Best first test: YouTube Japanese video
- Works better on normal browser videos than on DRM sites

FIRST TIME SETUP
0. git clone https://github.com/MohammdKopa/kami-subs.git or download
1. Put these BAT files in the root of the kami-subs folder
2. Double-click setup-edge.bat
3. Edge will open extensions page
4. Turn ON Developer mode
5. Click Load unpacked
6. Select the extension folder inside the repo
7. Pin the Kami Subs extension

HOW TO USE
1. Open a video in Edge
2. Click the Kami Subs extension
3. Set:
   - Source language: Japanese
   - Target language: English
   - Model: tiny or small
   - Device: cpu
4. Click Start
5. Wait a few seconds for subtitles

IF START DOES NOT WORK
1. Double-click run-backend.bat
2. Keep that window open
3. Go back to Edge
4. Click Start again

NOTES
- First run may take longer because model files download
- CPU is slower than GPU
- Netflix / Disney+ and some protected sites may not work
- YouTube is the best site to test first
