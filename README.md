# MUDRA (SIH26171) 🛡️
> **On-Device Visual Perception & Privacy-Preserving Execution for Browser Agents**  
> *ISRO / Department of Space · Smart Automation · SIH 2024 Finalist*

---

## ⚡ What is MUDRA?
MUDRA ensures **zero raw PII leaves the browser** when using AI browser agents. It performs local perception, automated redacting of sensitive inputs into opaque reference tokens, on-device policy enforcement (grants), and audit logging before sending sanitized scene-graph data to the backend planner.

---

## 🏗️ Core Architecture
```
 ┌─────────────────────────────────────────────────────────────┐
 │                    USER DEVICE (BROWSER)                    │
 │ 1. Perception Walker ➔ Extract DOM & Visual Candidates      │
 │ 2. Detection Engine  ➔ Detect PII (PAN, Aadhaar, Cards)     │
 │ 3. Redaction Engine  ➔ Replace values with opaque tokens    │
 │ 4. Grant Manager     ➔ Enforce local action security policy │
 └──────────────────────────────┬──────────────────────────────┘
                                │  Opaque Refs + Scene Graph
                                ▼ (NO raw values / PII)
 ┌─────────────────────────────────────────────────────────────┐
 │                    STATALESS BACKEND AGENT                  │
 │ 5. Planner (Gemini)  ➔ Generates safe 6-verb agent action   │
 │ 6. Egress Manifest   ➔ Records audit trail of execution     │
 └─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Key Features

### 1. 🔒 Local Redaction & Opaque Tokens
- Detects PII locally via pattern rules & identity algorithms (PAN, Aadhaar with Verhoeff check, Credit Cards with Luhn check, IFSC, UPI VPA, Email, SSN, Passport).
- Obfuscates field values into request-scoped opaque tokens (e.g. `ref_3a1b`). Raw values **never** cross the network.

### 2. 🛡️ On-Device Action Execution & Grants
- Restricts agent capabilities to strict, pre-authorized user grants (`click_handle`, `set_public_text`, `set_secret_ref`, `scroll`, `navigate_allowed_url`, `request_commit`).
- Refuses unauthorized actions, cross-origin navigations, and ungranted operations automatically.

### 3. 📜 Real-Time Egress Audit Manifest Viewer
- Backend maintains a real-time audit manifest (`GET /manifests/viewer/html`).
- Inspect allowed and refused outbound actions with zero exposure of sensitive data.

---

## 🛠️ Quick Start & Installation

### 1. Run Backend Server
```bash
cd backend
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# Start backend FastAPI server
uvicorn app.main:app --host 127.0.0.1 --port 8000
```
- **API Docs**: `http://127.0.0.1:8000/docs`
- **Audit Manifest Viewer**: `http://127.0.0.1:8000/manifests/viewer/html`

### 2. Build Chrome Extension
```bash
cd extension
npm install
npm run build
```
- Open Chrome -> `chrome://extensions` -> Enable **Developer mode**.
- Click **Load unpacked** and select `c:\Users\USER\Documents\clio\extension\dist`.

### 3. Run Automated Tests
```bash
# Backend PyTest Suite (40 tests)
cd backend
.venv\Scripts\python.exe -m pytest ..\tests\backend

# Extension Vitest Suite (60 tests)
cd extension
npm test
```

---

## 🧪 Current Implementation Status
- ✅ **Local Detection & Redaction Engine** (PAN, Aadhaar + Verhoeff, Cards + Luhn, IFSC, UPI, Email, SSN, Passport).
- ✅ **Stateless Agent Planner Backend** (FastAPI, 6-verb closed enum action space).
- ✅ **Real-Time Egress Audit Manifest Viewer** (REST Endpoints & Visual HTML UI).
- ✅ **100% Passing Test Suite** (40 Backend + 60 Extension Unit/Integration Tests).
