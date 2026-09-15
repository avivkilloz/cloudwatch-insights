import os
import tempfile

# Must run before any `app.*` module is imported (they set up the SQLite
# engine at import time), so this has to live at conftest module scope.
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="cw-insights-test-"))
