from backend.assistant_routes import _is_tool_compat_error, _should_send_tools


def test_gemini_openai_compat_tools_enabled_by_default(monkeypatch):
    send_tools, reason = _should_send_tools("gemini", "gemini-flash-recent")

    assert send_tools is True
    assert reason is None


def test_openrouter_tools_enabled_before_provider_retry():
    send_tools, reason = _should_send_tools(
        "openrouter-free", "google/gemma-3-1b-it:free"
    )

    assert send_tools is True
    assert reason is None


def test_local_openai_compat_tools_still_disabled_by_default():
    send_tools, reason = _should_send_tools("ollama", "llama3.1")

    assert send_tools is False
    assert reason == "ollama tool support is not guaranteed"


def test_tool_compat_errors_include_openrouter_and_gemini_messages():
    assert _is_tool_compat_error(
        404,
        'No endpoints found that support tool use. Try disabling "getElements".',
    )
    assert _is_tool_compat_error(
        400,
        "Function call is missing a thought_signature in functionCall parts.",
    )


def test_non_tool_errors_are_not_swallowed():
    assert (
        _is_tool_compat_error(404, "No endpoints found that support image input")
        is False
    )
    assert _is_tool_compat_error(500, "tool gateway exploded") is False
