"""The running app's OpenAPI schema names every operation once.

FastAPI builds the schema the first time anything asks for /openapi.json (the
docs page, a client generator, a test) and warns for every operation id two
routes share. The Gemini proxy registered GET, POST and OPTIONS under one
``api_route``, which gives the three methods one id, so every build of the
schema warned and a generated client saw one operation where there are three.
"""

from __future__ import annotations

import warnings
from collections import Counter


def test_the_real_apps_schema_names_every_operation_once():
    from backend.server import app

    app.openapi_schema = None
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        schema = app.openapi()
    duplicates = [
        str(w.message) for w in caught if "Duplicate Operation ID" in str(w.message)
    ]
    assert duplicates == []

    ids = Counter(
        operation["operationId"]
        for item in schema["paths"].values()
        for operation in item.values()
        if isinstance(operation, dict) and "operationId" in operation
    )
    assert [op for op, n in ids.items() if n > 1] == []

    proxy = schema["paths"]["/api/genai-proxy/{rest}"]
    assert sorted(proxy) == ["get", "options", "post"]
    assert len({proxy[m]["operationId"] for m in proxy}) == 3
