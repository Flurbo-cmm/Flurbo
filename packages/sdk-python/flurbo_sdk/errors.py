"""Errors. Messages are safe to show: no credentials, keys or upstream bodies."""


class FlurboError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status

    @property
    def message(self) -> str:
        return str(self)
