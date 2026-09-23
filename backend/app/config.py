import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    """Runtime configuration.

    `PLANNER` selects which brain answers:

      gemini  — the hosted planner. Needs a key and a network.
      ollama  — a local vision-language model over HTTP, on this machine.
                Accepts the redacted screenshot. This is the offline path.
      stub    — deterministic plans against the same schema, no key and no
                network at all.

    The default is deliberately *not* `stub`. A stub that ran by default
    would mean a misconfigured backend quietly served canned plans that look
    like a working agent, and nobody would notice until a judge asked it to
    do something the canned plan did not cover. A missing key failing loudly
    is the better outcome, so `stub` must be asked for by name.
    """

    PLANNER: str = os.getenv("PLANNER", "gemini").strip().lower()

    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")

    # Ollama. The model is a small VLM so it fits alongside a browser on a
    # laptop; 3B at 4-bit is roughly 3 GB resident.
    OLLAMA_URL: str = os.getenv("OLLAMA_URL", "http://localhost:11434")
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "qwen2.5vl:3b")
    OLLAMA_TIMEOUT_S: float = float(os.getenv("OLLAMA_TIMEOUT_S", "120"))

    HOST: str = os.getenv("HOST", "127.0.0.1")
    PORT: int = int(os.getenv("PORT", "8000"))

    @classmethod
    def valid_planners(cls) -> tuple[str, ...]:
        return ("gemini", "ollama", "stub")


settings = Settings()
