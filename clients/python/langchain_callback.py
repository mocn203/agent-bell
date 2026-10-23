"""
LangChain Callback Handler for Universal Telegram Notifier
Add to any LangChain agent or chain to get instant Telegram push alerts on completion.
"""

from typing import Any, Dict
from notifier import notify

class TelegramNotifierCallback:
    """Zero-dependency callback handler for LangChain chains and agents."""

    def __init__(self, workspace: str = "LangChain Project", user: str = None):
        self.workspace = workspace
        self.user = user

    def on_chain_end(self, outputs: Dict[str, Any], **kwargs: Any) -> None:
        summary = str(outputs.get("output", outputs))
        notify(task="LangChain Task Finished", summary=summary, workspace=self.workspace, user=self.user)

    def on_chain_error(self, error: BaseException, **kwargs: Any) -> None:
        pass
