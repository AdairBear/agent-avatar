"""Voice bridge: the Mac side of the ESP32 voice panel.

Speaks the xiaozhi-esp32 WebSocket protocol so a stock xiaozhi firmware can be
pointed here instead of the xiaozhi cloud. Audio is transcribed locally by
whisper.cpp; the text is either pasted into the focused app or sent to Claude.
"""

__version__ = "0.1.0"
