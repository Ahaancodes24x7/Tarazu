# How to show the Tarazu demo

A 7-minute live demo, with a 2-minute version at the end. Every button name below is exactly as it appears on screen.

## 1. One-time setup (do this the day before)

On the demo laptop, in PowerShell:

```powershell
cd D:\OneDrive\Desktop\Tarazu
pip install -r requirements.txt
python tools/build_mobile.py          # builds the offline phone version (needs internet once, about 20 MB)
cd backend; python -m pytest -q; cd ..   # should end with "passed"
```

Optional, for a real Android phone: push the code to GitHub, open the repository's **Actions** tab, open the latest **Tests and Android app** run, download **tarazu-android-apk**, unzip it, copy `app-debug.apk` to the phone and open it there. Allow "install unknown apps" when the phone asks.

## 2. Ten minutes before

1. **Start with a clean workspace.** Close any running Tarazu window, then rename the old data so the demo starts empty:
   ```powershell
   cd D:\OneDrive\Desktop\Tarazu
   if (Test-Path data\tarazu.sqlite3) { Rename-Item data\tarazu.sqlite3 "tarazu-before-demo.sqlite3" }
   ```
2. **Terminal 1, start Tarazu:**
   ```powershell
   python run.py
   ```
   To also show it on a real phone over Wi-Fi, use `$env:HOST="0.0.0.0"; python run.py` instead.
3. **Terminal 2, start the offline phone build:**
   ```powershell
   python tools/serve_app.py
   ```
4. **Open three browser tabs, in this order:**
   - Tab 1: http://127.0.0.1:8000 (landing page)
   - Tab 2: http://127.0.0.1:8000/demo.html (walkthrough)
   - Tab 3: http://127.0.0.1:8000/phone.html (phone preview)
5. Press F11 for full screen and set the zoom to 100%.

## 3. The demo, step by step (about 7 minutes)

### 0:00 The problem (landing page, tab 1)

- **Do:** tap the left pan of the balance, then the right one.
- **Say:** "A jeweller gives a karigar 100 grams of 22 karat gold. 95 grams of jewellery and 4 grams of scrap come back, so 0.916 grams of pure gold is not on the books. Today that is settled by memory and pressure, and the karigar usually pays. Tarazu settles it with evidence both sides can see."

### 0:45 How it thinks (walkthrough, tab 2)

Click the **▶** button under the board (or press the right arrow key) to go through the seven steps, with one line at each:

1. **The job:** "These are the slips both sides already write."
2. **Only pure metal counts:** "We balance pure gold, weight times purity, not gross weight."
3. **The gap:** "0.916 grams of pure gold is unaccounted for."
4. **Real gap or scale noise:** "Every scale has an error, so the gap is a range. This one is well outside it, so it's real. If it were inside, Tarazu would stay silent."
5. **What could explain it:** "It tries 31 possible record mistakes; these fit the numbers exactly."
6. **The next check:** "It picks the check that rules out the most for the least effort."
7. **What both sides hear:** "The wording never says stolen or missing. Only 'unaccounted for'."

- **Do:** tap **हिं**, then **ਪੰ**. "The whole board in Hindi and Punjabi." Tap **EN** to go back.

### 2:30 The real workspace (tab 1)

1. Click **Open your workspace**.
2. Click **Load sample workshop**. Five sample jobs appear, each labelled Sample.
3. **Say:** "Every job sits on this difference spectrum. Orange means metal unaccounted for, blue means more came back, green is within tolerance." Drag across the spectrum to filter, then click **All**.
4. Open **Worked example: 22 K bangle (demo)**.
5. **Say:** "Each record is a weight on its pan. The dashed outline is the missing metal."
6. In the explanations list, click **Preview on balance** on any explanation. "Anyone can see what the balance would look like if this were true. Nothing is recorded and nobody is blamed." Click it again to clear.
7. Drag the **replay** slider to the left and back. "Step through the records to see where the gap appeared." Click **Back to now** if it shows.
8. Find the next-check card, click **Record what the check found**, and answer the three checks Tarazu asks for, in this order:
   - Weigh the scrap and sweepings bag: **nothing extra**
   - Reweigh Finished return 1 on the second scale: **weight matches entry**
   - Weigh any item still at the karigar's bench: **item found at bench**

   **Say:** "Three checks instead of a whole checklist. One explanation is left: metal still at the bench."
9. Click **Record evidence**. In the dialog, type **1.000** as the measured weight and click **Add to the records**. "The fix is added as a new record. Nothing is ever edited or deleted. The balance is now level."
10. Click **Draft settlement**, then **Sign as jeweller**.
11. Open the account menu at the top right (the **J** button). Under **Viewing as**, choose **Karigar · Karigar K-01 (demo)**, open the same job and click **Sign as karigar**. "Final only when both sign. The karigar sees exactly the same figures, and only his own jobs."

### 5:00 On a phone (tab 3)

1. **Say:** "This is the same workspace at phone size." Click **Worked example case** and scroll inside the phone. Point out the bottom tabs.
2. Under **Engine**, click **On the phone, offline**. **Say:** "Now the whole engine runs inside the phone itself, with no server and no internet. This is the Android app." Wait a few seconds for it to start, then click **Load sample workshop** inside the phone. The offline version has its own storage, so it starts empty.
3. *(Optional)* Show the real phone with the APK, or open `http://<laptop address>:8000/app.html` on a phone on the same Wi-Fi.

### 6:00 Evidence (tab 1)

1. Go back to tab 1 and click the **Evaluation** tab, then **Run**. It takes a few seconds.
2. **Say:** "On a simulated workshop, labelled as simulated: 0 false alerts on 60 clean jobs, where a plain ledger raised 60. The true cause was in the list in 86 of 87 fault cases. It took 2.9 checks on average against 4.1 for a fixed checklist. The next step is a physical trial with real scales, and the toolkit to run it blind and pre-registered is already in the repository."

### 6:45 Close

"Free, open source, works offline, in three languages. It never accuses; it weighs the evidence."

## 4. The 2-minute version

1. Walkthrough, tab 2: steps 1, 3, 4 and 7, then tap **हिं**.
2. Tab 1: **Open your workspace**, then **Load sample workshop**, open the worked example, and click **Preview on balance** once.
3. Tab 3: show the phone and switch to **On the phone, offline**.

## 5. If something goes wrong

| Problem | Fix |
|---|---|
| The page will not open | Check terminal 1 is still running `python run.py`. Restart it. |
| "On the phone, offline" is greyed out | Terminal 2 is not running. Start `python tools/serve_app.py` and reload tab 3. |
| The workspace already has jobs | That's fine: open the worked example directly. To start empty, do step 2.1 again. |
| The worked example checks were already answered | Click **Restart checks** under the check card in that case. |
| No internet at the venue | Everything works offline, including fonts. |
| Read aloud is silent | The laptop has no voice for that language. The sentences are also on screen under **What read aloud says**. |

## 6. After the demo

Stop both terminals with Ctrl+C. To get your earlier data back, delete the demo's `data\tarazu.sqlite3` and rename `tarazu-before-demo.sqlite3` back to `tarazu.sqlite3`.
