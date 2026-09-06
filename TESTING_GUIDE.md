# MUDRA — Collaborator Testing Guide 🛡️

Welcome! This guide will walk you through setting up **MUDRA** locally, running the backend agent, loading the Chrome Extension, and testing the privacy and redaction features end-to-end.

---

## 📋 1. Prerequisites
Ensure you have the following installed on your machine:
- **Node.js**: v18 or higher (`node -v`)
- **Python**: v3.10 or higher (`python --version`)
- **Google Chrome**: Latest version

---

## 📥 2. Clone & Branch Setup

```bash
# Clone the repository
git clone https://github.com/priyanshi-100506/mudra.git
cd mudra

# Fetch all branches and check out the latest testing branch
git fetch origin
git checkout feature/mudra-complete-testing
```

---

## 🐍 3. Start the Backend Agent (FastAPI)

1. Navigate to the `backend/` directory:
   ```bash
   cd backend
   ```
2. Create and activate a Python virtual environment:
   - **Windows (PowerShell)**:
     ```powershell
     python -m venv .venv
     .\.venv\Scripts\Activate.ps1
     ```
   - **Linux / macOS**:
     ```bash
     python3 -m venv .venv
     source .venv/bin/activate
     ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Verify `.env` file exists in `backend/.env` with your `GEMINI_API_KEY`:
   ```ini
   GEMINI_API_KEY=your_gemini_api_key_here
   HOST=127.0.0.1
   PORT=8000
   ```
5. Launch the backend server:
   ```bash
   uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```
   - **Health Check**: Open `http://127.0.0.1:8000/health` in your browser (should return `{"status": "ok", "gemini_configured": true}`).
   - **Live Audit Manifest**: Open `http://127.0.0.1:8000/manifests/viewer/html` to monitor outbound agent logs in real time.

---

## 🧩 4. Build & Load Chrome Extension

1. Open a new terminal window and navigate to `extension/`:
   ```bash
   cd extension
   npm install
   npm run build
   ```
2. Open **Google Chrome** and go to `chrome://extensions`.
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click **Load unpacked** and select the `extension/dist` directory.
5. **Enable File URL Access** *(Required for local HTML test files)*:
   - On the MUDRA extension card in `chrome://extensions`, click **Details**.
   - Scroll down and toggle **ON** `Allow access to file URLs`.

---

## 🧪 5. Testing Scenarios

### Scenario A: Web Test Page (`http://`)
1. Open `http://127.0.0.1:8000/test` in Chrome.
2. Open the MUDRA Extension side panel / popup.
3. Enter the task prompt:
   > *"Fill out the registration form with user details"*
4. Click **Start Task**.
5. Observe how inputs are converted to `ref_*` opaque handles locally before sending requests to the backend.

### Scenario B: Local Form Test Bench (`file://`)
1. Open `extension/sample.html` in Chrome.
2. Form fields include 8 supported PII categories (Aadhaar, Credit Card, PAN, Passport, SSN, Email, UPI, IFSC).
3. Test Verhoeff validation (Aadhaar `4991 1866 5121`) and Luhn validation (Credit Card `4532 0151 1283 0366`).

### Scenario C: Real-Time Audit Viewer
1. Keep `http://127.0.0.1:8000/manifests/viewer/html` open in a separate tab.
2. Each action executed by the agent will post an entry showing session ID, timestamp, action type, status (`allowed`/`refused`), and total count of redacted PII tokens.

---

## 🧪 6. Running Automated Test Suites

### Backend Unit & Integration Tests (PyTest)
```bash
cd backend
.venv\Scripts\python.exe -m pytest ..\tests\backend
# Output: 40 passed
```

### Extension Unit & Safety Tests (Vitest)
```bash
cd extension
npm test
# Output: 60 passed (0 skipped)
```
