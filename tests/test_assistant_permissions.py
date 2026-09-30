"""Permission policy tests for the Claude Code assistant (plan contract C3)."""

from pathlib import Path

import pytest

import backend.modules.assistant.permissions as p
from backend.modules.assistant.permissions import (
    AGENT_TOOLS,
    AMBIGUOUS_CD_PATH,
    AMBIGUOUS_WIN32_PATH,
    EDIT_TOOLS,
    READ_BASELINE_TOOLS,
    READ_TOOLS,
    SHELL_TOOLS,
    Decision,
    classify,
    cli_permission_mode,
    decide,
    self_modify_path,
)

REPO_ROOT = Path("C:/proj/theDAW")

# (case id, tool_name, input)
CASES: dict[str, tuple[str, dict]] = {
    "read": ("Read", {"file_path": "README.md"}),
    "edit_in_repo": (
        "Edit",
        {"file_path": "frontend/src/components/audio/WaveformEditor.tsx"},
    ),
    "edit_self_frontend": (
        "Write",
        {"file_path": "frontend/src/orb-kit/AssistantPanel.tsx"},
    ),
    "edit_self_backend": ("Edit", {"file_path": "backend/assistant_routes.py"}),
    "shell": ("Bash", {"command": "uv run pytest -q"}),
    "shell_self": (
        "Bash",
        {"command": "sed -i s/a/b/ backend/modules/assistant/permissions.py"},
    ),
    "agent": ("Task", {"prompt": "investigate the failing suite"}),
    "mcp_read": ("mcp__serena__get_diagnostics_for_file", {"relative_path": "x.py"}),
    "mcp_write": ("mcp__memory__create_entities", {"entities": []}),
}

EXPECTED_KIND = {
    "read": "read",
    "edit_in_repo": "edit",
    "edit_self_frontend": "edit",
    "edit_self_backend": "edit",
    "shell": "shell",
    "shell_self": "shell",
    "agent": "agent",
    "mcp_read": "read",
    "mcp_write": "mcp",
}

# mode -> case id -> expected action
MATRIX: dict[str, dict[str, str]] = {
    "readonly": {
        "read": "allow",
        "edit_in_repo": "deny",
        "edit_self_frontend": "deny",
        "edit_self_backend": "deny",
        "shell": "deny",
        "shell_self": "deny",
        "agent": "deny",
        "mcp_read": "allow",
        "mcp_write": "deny",
    },
    "ask": {
        "read": "allow",
        "edit_in_repo": "ask",
        "edit_self_frontend": "ask",
        "edit_self_backend": "ask",
        "shell": "ask",
        "shell_self": "ask",
        "agent": "ask",
        "mcp_read": "allow",
        "mcp_write": "ask",
    },
    "accept_edits": {
        "read": "allow",
        "edit_in_repo": "allow",
        "edit_self_frontend": "ask",
        "edit_self_backend": "ask",
        "shell": "ask",
        "shell_self": "ask",
        "agent": "ask",
        "mcp_read": "allow",
        "mcp_write": "ask",
    },
    "trusted": {
        "read": "allow",
        "edit_in_repo": "allow",
        "edit_self_frontend": "ask",
        "edit_self_backend": "ask",
        "shell": "allow",
        "shell_self": "ask",
        "agent": "allow",
        "mcp_read": "allow",
        "mcp_write": "allow",
    },
}

SELF_MODIFY_CASES = {"edit_self_frontend", "edit_self_backend", "shell_self"}
BACKEND_RESTART_CASES = {"edit_self_backend", "shell_self"}


def _decide(mode: str, case_id: str, **kwargs) -> Decision:
    tool_name, tool_input = CASES[case_id]
    params = {
        "session_allow": set(),
        "deny_count": 0,
        "repo_root": REPO_ROOT,
    }
    params.update(kwargs)
    return decide(mode, tool_name, tool_input, **params)


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_classify_matches_contract_kinds(case_id):
    tool_name, tool_input = CASES[case_id]

    assert classify(tool_name, tool_input) == EXPECTED_KIND[case_id]


@pytest.mark.parametrize("mode", sorted(MATRIX))
@pytest.mark.parametrize("case_id", sorted(CASES))
def test_full_mode_matrix(mode, case_id):
    decision = _decide(mode, case_id)

    assert decision.action == MATRIX[mode][case_id]
    assert decision.kind == EXPECTED_KIND[case_id]
    assert decision.reason


@pytest.mark.parametrize("mode", sorted(MATRIX))
@pytest.mark.parametrize("case_id", sorted(CASES))
def test_self_modify_flags_are_reported_in_every_mode(mode, case_id):
    decision = _decide(mode, case_id)

    assert decision.self_modify is (case_id in SELF_MODIFY_CASES)
    assert decision.backend_restart is (case_id in BACKEND_RESTART_CASES)
    if case_id in SELF_MODIFY_CASES:
        assert decision.self_modify_path is not None
    else:
        assert decision.self_modify_path is None


def test_self_modify_asks_in_trusted_mode_and_is_never_remembered():
    decision = _decide(
        "trusted",
        "edit_self_backend",
        session_allow={"Edit"},
        deny_count=9,
    )

    assert decision.action == "ask"
    assert decision.self_modify is True
    assert decision.self_modify_path == "backend/assistant_routes.py"
    assert decision.backend_restart is True


def test_readonly_denies_self_modify_and_never_asks():
    decision = _decide("readonly", "edit_self_backend")

    assert decision.action == "deny"
    assert decision.reason == "Read-only mode"
    assert decision.self_modify is True


def test_session_allow_short_circuits_ask_mode():
    decision = _decide("ask", "shell", session_allow={"Bash"})

    assert decision.action == "allow"

    without = _decide("ask", "shell", session_allow={"Write"})

    assert without.action == "ask"


def test_deny_count_of_three_stops_asking():
    twice = _decide("ask", "shell", deny_count=2)
    thrice = _decide("ask", "shell", deny_count=3)

    assert twice.action == "ask"
    assert thrice.action == "deny"
    assert thrice.reason == "declined 3\u00d7 — not asking again"


def test_session_allow_wins_over_deny_count():
    decision = _decide("ask", "shell", session_allow={"Bash"}, deny_count=5)

    assert decision.action == "allow"


def test_windows_absolute_path_normalises_to_repo_relative_posix():
    result = self_modify_path(
        "Edit",
        {"file_path": "C:\\proj\\theDAW\\backend\\assistant_routes.py"},
        REPO_ROOT,
    )

    assert result == "backend/assistant_routes.py"


def test_windows_absolute_path_decides_as_self_modify():
    decision = decide(
        "accept_edits",
        "Edit",
        {"file_path": "C:\\proj\\theDAW\\frontend\\src\\orb-kit\\useChatStream.ts"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify is True
    assert decision.self_modify_path == "frontend/src/orb-kit/useChatStream.ts"
    assert decision.backend_restart is False


def test_notebook_edit_uses_notebook_path():
    result = self_modify_path(
        "NotebookEdit",
        {"notebook_path": "backend/modules/assistant/scratch.ipynb"},
        REPO_ROOT,
    )

    assert result == "backend/modules/assistant/scratch.ipynb"


def test_path_outside_repo_is_not_self_modify_and_still_asks():
    decision = decide(
        "accept_edits",
        "Write",
        {"file_path": "D:\\elsewhere\\backend\\assistant_routes.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert decision.self_modify_path is None
    assert decision.action == "ask"


def test_backend_restart_true_for_ordinary_backend_python_edit():
    decision = _decide("ask", "edit_in_repo")
    backend_edit = decide(
        "ask",
        "Edit",
        {"file_path": "backend/modules/midi/engine.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.backend_restart is False
    assert backend_edit.backend_restart is True
    assert backend_edit.self_modify is False


def test_read_tool_on_self_surface_is_not_self_modify():
    decision = _decide("ask", "read")
    reading_self = decide(
        "ask",
        "Read",
        {"file_path": "backend/assistant_routes.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert reading_self.self_modify is False
    assert reading_self.action == "allow"


@pytest.mark.parametrize(
    "tool_name,expected",
    [
        ("mcp__serena__list_dir", "read"),
        ("mcp__docs-mcp-server__search_docs", "read"),
        ("mcp__deepwiki__read_wiki_contents", "read"),
        ("mcp__everything-search__find_files", "read"),
        ("mcp__serena__get", "read"),
        ("mcp__playwright__browser_click", "mcp"),
        ("mcp__memory__delete_entities", "mcp"),
        # Boundary: a read prefix glued to more letters is NOT a read (B3).
        ("mcp__serena__getaway_write", "mcp"),
        ("mcp__serena__listen_and_delete", "mcp"),
        ("mcp__serena__finder_destroy", "mcp"),
    ],
)
def test_mcp_tool_name_prefix_classification(tool_name, expected):
    assert classify(tool_name, {}) == expected


def test_unknown_tool_is_other():
    assert classify("SomeFutureTool", {}) == "other"
    assert classify("", {}) == "other"


def test_shell_self_surface_detection_handles_quoted_windows_token():
    result = self_modify_path(
        "Bash",
        {"command": 'python "C:\\proj\\theDAW\\backend\\rag.py" --rebuild'},
        REPO_ROOT,
    )

    assert result == "backend/rag.py"


def test_shell_with_unbalanced_quotes_still_classifies():
    """G5 batch-11 item 4: the old shlex-based tokenizer raised ValueError on
    an unbalanced quote and fell back to a naive space-split, which is why
    this used to assert ``self_modify is True`` -- ``backend/rag.py`` landed
    on its own token only as a side effect of that fallback. The hand-rolled
    tokenizer ported from the TS ``shellTokens`` (mandated by item 4, no
    fallback branch) accumulates everything after an unterminated quote,
    embedded spaces included, into one token -- matching the TS port exactly
    (which has no equivalent fallback and no equivalent test pinning the old
    behaviour either). This command was never an actual write to
    ``backend/rag.py`` in the first place (no redirect, just an ``echo``
    argument) -- the old assertion pinned a false positive from the
    discarded implementation, not a real catch. ``kind`` classification is
    unaffected either way; only the self-modify verdict for this specific,
    non-write command changes.
    """
    decision = decide(
        "ask",
        "Bash",
        {"command": 'echo "unbalanced backend/rag.py'},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.kind == "shell"
    assert decision.self_modify is False


def test_cli_permission_mode_mapping():
    # G5 audit item 1 (CRITICAL): every mode maps to the CLI's "default" --
    # never acceptEdits/bypassPermissions, which make the CLI auto-approve
    # tools itself with no control_request, bypassing decide() entirely.
    assert cli_permission_mode("ask") == "default"
    assert cli_permission_mode("accept_edits") == "default"
    assert cli_permission_mode("readonly") == "default"
    assert cli_permission_mode("trusted") == "default"


def test_cli_permission_mode_rejects_unknown_mode():
    with pytest.raises(ValueError):
        cli_permission_mode("yolo")


def test_read_baseline_tools_is_the_allowed_tools_list():
    assert list(READ_BASELINE_TOOLS) == [
        "Read",
        "Grep",
        "Glob",
        "LS",
        "WebFetch",
        "WebSearch",
        "TodoWrite",
        "NotebookRead",
    ]
    assert set(READ_BASELINE_TOOLS) == READ_TOOLS


def test_tool_sets_match_contract():
    assert EDIT_TOOLS == {"Edit", "Write", "MultiEdit", "NotebookEdit"}
    assert SHELL_TOOLS == {"Bash", "PowerShell"}
    assert AGENT_TOOLS == {"Agent", "Task"}


@pytest.mark.parametrize(
    "raw",
    [
        "C:\\proj\\theDAW\\..\\theDAW\\backend\\rag.py",
        "C:/proj/theDAW/../theDAW/backend/rag.py",
        "C:\\proj\\theDAW\\backend\\..\\backend\\rag.py",
        "backend/../backend/rag.py",
        "frontend/src/orb-kit/../orb-kit/useChatStream.ts/../useChatStream.ts",
    ],
)
def test_traversal_inside_repo_still_resolves_to_self_surface(raw):
    """B1: `..` segments must not smuggle a self-surface write past the policy."""
    result = self_modify_path("Write", {"file_path": raw}, REPO_ROOT)

    assert result in ("backend/rag.py", "frontend/src/orb-kit/useChatStream.ts")


@pytest.mark.parametrize(
    "raw",
    [
        "C:\\proj\\theDAW\\..\\other\\backend\\rag.py",
        "C:/proj/theDAW/../../elsewhere/backend/rag.py",
        "../outside/backend/rag.py",
        "../../backend/rag.py",
    ],
)
def test_traversal_that_leaves_the_repo_is_not_self_modify(raw):
    """B1: genuine escapes stay outside the repo and are not self-surface."""
    assert self_modify_path("Write", {"file_path": raw}, REPO_ROOT) is None


def test_traversal_decides_as_self_modify_in_trusted_mode():
    decision = decide(
        "trusted",
        "Edit",
        {"file_path": "C:\\proj\\theDAW\\..\\theDAW\\backend\\assistant_routes.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify_path == "backend/assistant_routes.py"
    assert decision.backend_restart is True


@pytest.mark.parametrize(
    "command",
    [
        "echo hi >backend/rag.py",
        "echo hi >>backend/rag.py",
        "python -m foo 2>backend/rag.py",
        "python -m foo 1>backend/rag.py",
        "generate --output=backend/rag.py",
        "dd if=/dev/zero of=backend/rag.py",
        "patch <backend/rag.py",
        "tee >backend/rag.py",
        'echo hi >"backend/rag.py"',
        "python gen.py --out=C:\\proj\\theDAW\\backend\\rag.py",
    ],
)
def test_glued_shell_redirect_tokens_are_detected(command):
    """B2: a path glued to a redirect/flag operator is still a write target."""
    assert self_modify_path("Bash", {"command": command}, REPO_ROOT) == "backend/rag.py"


def test_glued_shell_token_decides_as_self_modify():
    decision = decide(
        "trusted",
        "Bash",
        {"command": "echo pwned >backend/modules/assistant/permissions.py"},
        session_allow={"Bash"},
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify_path == "backend/modules/assistant/permissions.py"
    assert decision.backend_restart is True


def test_glued_token_without_a_repo_path_is_not_self_modify():
    decision = decide(
        "ask",
        "Bash",
        {"command": "curl https://example.com/x --output=/tmp/out.bin 2>/dev/null"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert decision.self_modify_path is None
    assert decision.backend_restart is False


def test_powershell_is_a_shell_tool_through_decide():
    """B4: PowerShell follows the same shell rules as Bash."""
    plain = decide(
        "ask",
        "PowerShell",
        {"command": "Get-ChildItem backend"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    trusted = decide(
        "trusted",
        "PowerShell",
        {"command": "Get-ChildItem backend"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    readonly = decide(
        "readonly",
        "PowerShell",
        {"command": "Get-ChildItem backend"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert (plain.kind, plain.action) == ("shell", "ask")
    assert (trusted.kind, trusted.action) == ("shell", "allow")
    assert (readonly.kind, readonly.action) == ("shell", "deny")


def test_powershell_touching_self_surface_always_asks():
    decision = decide(
        "trusted",
        "PowerShell",
        {"command": "Set-Content -Path backend/rag.py -Value x"},
        session_allow={"PowerShell"},
        deny_count=7,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify_path == "backend/rag.py"


def test_multiedit_is_an_edit_tool_through_decide():
    """B4: MultiEdit carries file_path like the other edit tools."""
    in_repo = decide(
        "accept_edits",
        "MultiEdit",
        {
            "file_path": "frontend/src/components/audio/WaveformEditor.tsx",
            "edits": [{"old_string": "a", "new_string": "b"}],
        },
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    self_surface = decide(
        "accept_edits",
        "MultiEdit",
        {
            "file_path": "C:\\proj\\theDAW\\backend\\modules\\assistant\\permissions.py",
            "edits": [{"old_string": "a", "new_string": "b"}],
        },
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert (in_repo.kind, in_repo.action) == ("edit", "allow")
    assert in_repo.self_modify is False
    assert (self_surface.kind, self_surface.action) == ("edit", "ask")
    assert self_surface.self_modify_path == "backend/modules/assistant/permissions.py"
    assert self_surface.backend_restart is True


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("C:\\proj\\theDAW\\Backend\\RAG.py", "Backend/RAG.py"),
        ("c:\\proj\\thedaw\\backend\\rag.py", "backend/rag.py"),
        ("c:/PROJ/theDAW/backend/assistant_routes.py", "backend/assistant_routes.py"),
        ("Backend/assistant_routes.py", "Backend/assistant_routes.py"),
        ("FRONTEND/src/orb-kit/x.ts", "FRONTEND/src/orb-kit/x.ts"),
        (
            "backend\\Modules\\Assistant\\Permissions.py",
            "backend/Modules/Assistant/Permissions.py",
        ),
    ],
)
def test_case_variant_self_surface_is_detected_on_windows_roots(raw, expected):
    """V2-1: NTFS is case-insensitive, so `Backend\\RAG.py` IS `backend/rag.py`."""
    assert self_modify_path("Edit", {"file_path": raw}, REPO_ROOT) == expected


@pytest.mark.parametrize("mode", ["trusted", "accept_edits"])
@pytest.mark.parametrize(
    "raw",
    [
        "C:\\proj\\theDAW\\Backend\\RAG.py",
        "c:\\proj\\theDAW\\backend\\rag.py",
        "Backend/assistant_routes.py",
        "FRONTEND/src/orb-kit/x.ts",
    ],
)
def test_case_variant_self_surface_asks_in_permissive_modes(mode, raw):
    decision = decide(
        mode,
        "Edit",
        {"file_path": raw},
        session_allow={"Edit"},
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is True
    assert decision.action == "ask"


def test_case_variant_backend_python_needs_restart_on_windows_roots():
    decision = decide(
        "trusted",
        "Edit",
        {"file_path": "BACKEND\\Modules\\Midi\\Engine.PY"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert decision.backend_restart is True
    assert decision.action == "allow"


def test_case_variant_is_case_sensitive_on_posix_roots(monkeypatch):
    """On a case-sensitive filesystem `Backend/` is a different directory."""
    import backend.modules.assistant.permissions as permissions

    monkeypatch.setattr(permissions.sys, "platform", "linux")
    posix_root = Path("/srv/theDAW")

    assert self_modify_path("Edit", {"file_path": "Backend/rag.py"}, posix_root) is None
    assert (
        self_modify_path("Edit", {"file_path": "backend/rag.py"}, posix_root)
        == "backend/rag.py"
    )


def test_windows_platform_is_case_insensitive_even_for_posix_style_root(monkeypatch):
    import backend.modules.assistant.permissions as permissions

    monkeypatch.setattr(permissions.sys, "platform", "win32")

    assert (
        self_modify_path("Edit", {"file_path": "Backend/rag.py"}, Path("/srv/theDAW"))
        == "Backend/rag.py"
    )


@pytest.mark.parametrize(
    "command",
    [
        "echo x >backend/rag.py;",
        "echo x > backend/rag.py; ls",
        "echo x > backend/rag.py&&ls",
        "echo x >backend/rag.py&&ls",
        "echo x >|backend/rag.py",
        "(echo x >backend/rag.py)",
        "(echo x > backend/rag.py)",
        "cat a|tee backend/rag.py|wc",
        "true&&cp a backend/rag.py",
        "cp a backend/rag.py&",
    ],
)
def test_glued_shell_separators_do_not_hide_the_target(command):
    """V2-2: `;`, `&&`, `|`, `(`, `)` glued to a path must not defeat detection."""
    assert self_modify_path("Bash", {"command": command}, REPO_ROOT) == "backend/rag.py"


def test_glued_separator_decides_as_self_modify_in_trusted_mode():
    decision = decide(
        "trusted",
        "Bash",
        {"command": "echo pwned > backend/assistant_routes.py; ls"},
        session_allow={"Bash"},
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.action == "ask"
    assert decision.self_modify_path == "backend/assistant_routes.py"


def test_colon_separator_variant_is_detected():
    """V2-4: `--out:path` style flags (MSVC, robocopy) name a write target."""
    assert (
        self_modify_path("Bash", {"command": "tool --out:backend/rag.py"}, REPO_ROOT)
        == "backend/rag.py"
    )


def test_url_containing_a_self_surface_path_is_not_self_modify():
    """V2-4 false-positive guard: a URL path is not a repo path."""
    decision = decide(
        "ask",
        "Bash",
        {"command": "curl https://host/backend/rag.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )

    assert decision.self_modify is False
    assert decision.self_modify_path is None
    assert decision.backend_restart is False
    assert decision.action == "ask"


def test_decide_rejects_unknown_mode():
    with pytest.raises(ValueError):
        decide(
            "supervised",
            "Read",
            {"file_path": "README.md"},
            session_allow=set(),
            deny_count=0,
            repo_root=REPO_ROOT,
        )


# ---------------------------------------------------------------------------
# m4: Win32 long-path prefix (\?\) and Git-Bash drive form (/c/...)
# ---------------------------------------------------------------------------


def test_win32_long_path_prefix_is_stripped_before_the_root_comparison():
    result = self_modify_path(
        "Edit",
        {"file_path": r"\\?\C:\proj\theDAW\backend\rag.py"},
        REPO_ROOT,
    )
    assert result == "backend/rag.py"


def test_git_bash_drive_path_maps_onto_the_matching_windows_root():
    result = self_modify_path(
        "Edit",
        {"file_path": "/c/proj/theDAW/backend/rag.py"},
        REPO_ROOT,
    )
    assert result == "backend/rag.py"


def test_git_bash_drive_path_does_not_match_a_different_drive_letter():
    result = self_modify_path(
        "Edit",
        {"file_path": "/d/proj/theDAW/backend/rag.py"},
        REPO_ROOT,
    )
    assert result is None


def test_git_bash_drive_path_decides_as_self_modify_through_decide():
    decision = decide(
        "trusted",
        "Edit",
        {"file_path": "/c/proj/theDAW/backend/assistant_routes.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"
    assert decision.self_modify is True
    assert decision.self_modify_path == "backend/assistant_routes.py"


def test_real_single_letter_posix_directory_is_not_misread_as_a_git_bash_drive():
    # A POSIX repo root that happens to be a single letter ("/a") must resolve
    # normally -- the Git-Bash mapping only applies when the repo root ITSELF
    # is a Windows drive path (see repo_relative's rootIsWindowsStyle guard).
    posix_root = Path("/a")
    result = self_modify_path(
        "Edit",
        {"file_path": "/a/backend/rag.py"},
        posix_root,
    )
    assert result == "backend/rag.py"


def test_win32_unc_long_path_is_not_stripped_and_yields_the_ambiguous_sentinel():
    """G5 item 2 (regression): only the DRIVE-LETTER \\?\\ form may be
    stripped -- \\?\\UNC\\... must keep its //?/... prefix so it never
    collides with an innocent-looking repo-relative path. G5 item 4: this is
    NOT the same as "provably outside the repo" (None) -- it cannot be
    verified either way, so self_modify_path signals that distinctly."""
    result = self_modify_path(
        "Edit",
        {"file_path": "\\\\?\\UNC\\evil\\share\\x.txt"},
        REPO_ROOT,
    )
    assert result == AMBIGUOUS_WIN32_PATH
    assert result is not None


def test_win32_globalroot_device_path_is_not_stripped_and_yields_the_ambiguous_sentinel():
    """G5 item 2 (regression) + item 4: the raw device \\?\\GLOBALROOT\\...
    form must also keep its //?/... prefix and be treated as ambiguous."""
    result = self_modify_path(
        "Edit",
        {
            "file_path": "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\proj\\theDAW\\backend\\rag.py"
        },
        REPO_ROOT,
    )
    assert result == AMBIGUOUS_WIN32_PATH
    assert result is not None


def test_win32_drive_letter_long_path_still_strips_correctly():
    """No regression from the item-2 fix: the drive-letter form still works."""
    result = self_modify_path(
        "Edit",
        {"file_path": "\\\\?\\C:\\proj\\theDAW\\backend\\rag.py"},
        REPO_ROOT,
    )
    assert result == "backend/rag.py"


def test_shortest_self_surface_match_wins_over_a_raw_glued_shell_token():
    """G5 item 7: report the clean split path, not the raw token with a
    glued shell separator still attached (e.g. `a.py&&ls`).

    "backend/modules/assistant/**" matches via its trailing wildcard, so the
    RAW, unsplit token "backend/modules/assistant/permissions.py&&ls" is
    itself a (junk-suffixed) match -- exactly like the clean split piece
    "backend/modules/assistant/permissions.py" is. The shortest one must win.
    """
    result = self_modify_path(
        "Bash",
        {"command": "cmd backend/modules/assistant/permissions.py&&ls"},
        REPO_ROOT,
    )
    assert result == "backend/modules/assistant/permissions.py"


def test_shortest_self_surface_match_through_decide():
    decision = decide(
        "ask",
        "Bash",
        {"command": "cmd backend/modules/assistant/permissions.py&&ls"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.self_modify is True
    assert decision.self_modify_path == "backend/modules/assistant/permissions.py"


def test_decide_trusted_mode_asks_for_an_ambiguous_globalroot_device_write():
    """G5 item 4: the exact vulnerability -- trusted mode used to ALLOW this
    outright because self_modify_path returned None (not proven self-modify)
    for an unresolvable Win32 device path."""
    decision = decide(
        "trusted",
        "Edit",
        {
            "file_path": r"\\?\GLOBALROOT\Device\HarddiskVolume1\proj\theDAW\backend\rag.py"
        },
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize("mode", ["ask", "accept_edits", "trusted"])
def test_decide_asks_for_an_ambiguous_unc_write_in_every_non_readonly_mode(mode):
    decision = decide(
        mode,
        "Edit",
        {"file_path": r"\\?\UNC\evil\share\backend\rag.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


def test_decide_readonly_mode_still_denies_an_ambiguous_write():
    decision = decide(
        "readonly",
        "Edit",
        {
            "file_path": r"\\?\GLOBALROOT\Device\HarddiskVolume1\proj\theDAW\backend\rag.py"
        },
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "deny"


def test_decide_trusted_mode_still_allows_an_ordinary_in_repo_write():
    """No regression: an unambiguous path is unaffected."""
    decision = decide(
        "trusted",
        "Edit",
        {"file_path": "backend/modules/midi/engine.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


# ---------------------------------------------------------------------------
# G5 round 4 item 1 (CRITICAL): the sentinel covers all three NT-namespace
# prefixes, not just the drive-letter \\?\ form. Built with explicit
# backslash-character counting (BS = one literal backslash) rather than
# string literals in the test source, to make the exact byte content
# unambiguous and immune to any editor/tool re-escaping.
# ---------------------------------------------------------------------------
BS = chr(92)  # one literal backslash character

# \\?\C:\...   (drive-letter Win32 file namespace -- the one safe/strippable form)
_WIN32_QMARK_DRIVE = (
    BS
    + BS
    + "?"
    + BS
    + "C:"
    + BS
    + "proj"
    + BS
    + "theDAW"
    + BS
    + "backend"
    + BS
    + "rag.py"
)
# \\?\UNC\...  (UNC share under the Win32 file namespace)
_WIN32_QMARK_UNC = (
    BS
    + BS
    + "?"
    + BS
    + "UNC"
    + BS
    + "evil"
    + BS
    + "share"
    + BS
    + "backend"
    + BS
    + "rag.py"
)
# \\?\GLOBALROOT\Device\...  (raw device path under the Win32 file namespace)
_WIN32_QMARK_DEVICE = (
    BS
    + BS
    + "?"
    + BS
    + "GLOBALROOT"
    + BS
    + "Device"
    + BS
    + "HarddiskVolume1"
    + BS
    + "proj"
    + BS
    + "theDAW"
    + BS
    + "backend"
    + BS
    + "rag.py"
)
# \\.\C:\...  (Win32 device namespace, drive form)
_WIN32_DOT_DRIVE = (
    BS
    + BS
    + "."
    + BS
    + "C:"
    + BS
    + "proj"
    + BS
    + "theDAW"
    + BS
    + "backend"
    + BS
    + "rag.py"
)
# \\.\GLOBALROOT\Device\...  (Win32 device namespace, device form)
_WIN32_DOT_DEVICE = (
    BS
    + BS
    + "."
    + BS
    + "GLOBALROOT"
    + BS
    + "Device"
    + BS
    + "HarddiskVolume1"
    + BS
    + "proj"
    + BS
    + "theDAW"
    + BS
    + "backend"
    + BS
    + "rag.py"
)
# \??\C:\...  (NT-native namespace, drive form -- single leading backslash)
_WIN32_NT_DRIVE = (
    BS + "??" + BS + "C:" + BS + "proj" + BS + "theDAW" + BS + "backend" + BS + "rag.py"
)
# \??\GLOBALROOT\Device\...  (NT-native namespace, device form)
_WIN32_NT_DEVICE = (
    BS
    + "??"
    + BS
    + "GLOBALROOT"
    + BS
    + "Device"
    + BS
    + "HarddiskVolume1"
    + BS
    + "proj"
    + BS
    + "theDAW"
    + BS
    + "backend"
    + BS
    + "rag.py"
)
# C:\...  (an ordinary Windows absolute path, no NT-namespace prefix at all)
_WIN32_ORDINARY = "C:" + BS + "proj" + BS + "theDAW" + BS + "backend" + BS + "rag.py"


@pytest.mark.parametrize("raw", [_WIN32_DOT_DRIVE, _WIN32_NT_DRIVE])
def test_win32_other_namespace_drive_forms_are_ambiguous_not_resolved(raw):
    """The device-namespace and NT-native drive forms open the same real file
    as the drive-letter \\?\\ form but are NOT that safely-strippable shape --
    they must be ambiguous, never a clean path and never plain None."""
    result = self_modify_path("Edit", {"file_path": raw}, REPO_ROOT)
    assert result == AMBIGUOUS_WIN32_PATH
    assert result is not None


@pytest.mark.parametrize(
    "raw",
    [
        _WIN32_QMARK_UNC,
        _WIN32_QMARK_DEVICE,
        _WIN32_DOT_DRIVE,
        _WIN32_DOT_DEVICE,
        _WIN32_NT_DRIVE,
        _WIN32_NT_DEVICE,
    ],
)
def test_decide_trusted_mode_never_allows_any_nt_namespace_form(raw):
    """The exact round-4 vulnerability: trusted mode (the Foundry's default)
    must never silently allow any of the three NT-namespace prefixes."""
    decision = decide(
        "trusted",
        "Edit",
        {"file_path": raw},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


def test_win32_plain_drive_letter_form_still_resolves_cleanly():
    """No regression: the one safely-strippable form still works."""
    result = self_modify_path("Edit", {"file_path": _WIN32_QMARK_DRIVE}, REPO_ROOT)
    assert result == "backend/rag.py"


def test_normal_absolute_path_is_not_ambiguous():
    """No regression: an ordinary Windows absolute path (no NT-namespace
    prefix at all) is unaffected."""
    result = self_modify_path("Edit", {"file_path": _WIN32_ORDINARY}, REPO_ROOT)
    assert result == "backend/rag.py"
    assert result != AMBIGUOUS_WIN32_PATH

    decision = decide(
        "trusted",
        "Edit",
        {"file_path": "C:\\proj\\theDAW\\frontend\\src\\App.tsx"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


# G5 round 5: the auditor executed five OTHER Windows path spellings, beyond
# the three named NT-namespace prefixes above, that also open backend/rag.py
# byte-for-byte on the audited machine and were still resolving to "allow" in
# trusted mode. One test per row of the finding-1 table.

# \localhost\C$\...  (plain UNC, loopback hostname -- no NT-namespace prefix
# at all, so the old enumerated-prefix predicate never even looked at it)
_UNC_LOCALHOST = (
    BS
    + BS
    + "localhost"
    + BS
    + "C$"
    + BS
    + "proj"
    + BS
    + "theDAW"
    + BS
    + "backend"
    + BS
    + "rag.py"
)
# \127.0.0.1\C$\...  (plain UNC, loopback IP spelling)
_UNC_LOOPBACK_IP = (
    BS
    + BS
    + "127.0.0.1"
    + BS
    + "C$"
    + BS
    + "proj"
    + BS
    + "theDAW"
    + BS
    + "backend"
    + BS
    + "rag.py"
)
# C:backend\rag.py  (drive-relative -- CWD-dependent, no separator right
# after the drive colon)
_DRIVE_RELATIVE_PATH = "C:backend" + BS + "rag.py"
# backend\rag.py.  (trailing dot -- NTFS silently strips it)
_TRAILING_DOT_PATH = "backend" + BS + "rag.py."
# backend\rag.py::$DATA  (NTFS Alternate Data Stream -- opens rag.py's
# unnamed stream, i.e. rag.py itself)
_ADS_PATH = "backend" + BS + "rag.py::$DATA"
# backend\ASSIST~1.PY  (Windows 8.3 short name)
_SHORT_NAME_PATH = "backend" + BS + "ASSIST~1.PY"


@pytest.mark.parametrize(
    "raw",
    [_UNC_LOCALHOST, _UNC_LOOPBACK_IP],
    ids=["unc_localhost", "unc_loopback_ip"],
)
def test_plain_unc_loopback_forms_are_ambiguous_not_resolved(raw):
    """G5 round 5 item 1: plain UNC (no NT-namespace prefix at all) opening
    the real file via a loopback hostname or IP must be ambiguous, never a
    clean resolved path and never plain None."""
    result = self_modify_path("Edit", {"file_path": raw}, REPO_ROOT)
    assert result == AMBIGUOUS_WIN32_PATH
    assert result is not None


def test_drive_relative_path_is_ambiguous_not_resolved():
    """G5 round 5 item 1: `C:backend\rag.py` is CWD-dependent and can't be
    resolved as pure string work -- it must be ambiguous, not silently
    treated as outside the repo."""
    result = self_modify_path("Edit", {"file_path": _DRIVE_RELATIVE_PATH}, REPO_ROOT)
    assert result == AMBIGUOUS_WIN32_PATH


def test_trailing_dot_path_resolves_to_the_canonical_self_surface_file():
    """G5 round 5 item 1: NTFS strips a trailing `.` from a filename, so
    `backend\rag.py.` opens the identical file as `backend/rag.py` and must
    be canonicalized to the same self-surface match, not skip the glob."""
    result = self_modify_path("Edit", {"file_path": _TRAILING_DOT_PATH}, REPO_ROOT)
    assert result == "backend/rag.py"


def test_alternate_data_stream_path_resolves_to_the_canonical_self_surface_file():
    """G5 round 5 item 1: `backend\rag.py::$DATA` opens rag.py's own unnamed
    stream -- i.e. rag.py itself -- and must be canonicalized (truncated at
    the first `:`) to the same self-surface match."""
    result = self_modify_path("Edit", {"file_path": _ADS_PATH}, REPO_ROOT)
    assert result == "backend/rag.py"


def test_short_name_path_is_ambiguous_not_resolved():
    """G5 round 5 item 1: an 8.3 short-name segment (`ASSIST~1.PY`) can't be
    expanded as pure string work, so it must be ambiguous rather than
    silently treated as a clean, non-matching relative path."""
    result = self_modify_path("Edit", {"file_path": _SHORT_NAME_PATH}, REPO_ROOT)
    assert result == AMBIGUOUS_WIN32_PATH


@pytest.mark.parametrize(
    "raw",
    [
        _UNC_LOCALHOST,
        _UNC_LOOPBACK_IP,
        _DRIVE_RELATIVE_PATH,
        _SHORT_NAME_PATH,
    ],
    ids=["unc_localhost", "unc_loopback_ip", "drive_relative", "short_name"],
)
def test_decide_trusted_mode_never_allows_the_round_5_ambiguous_forms(raw):
    """The exact round-5 vulnerability: trusted mode (the Foundry's default)
    must never silently allow any of the five newly-audited path spellings
    that resolve ambiguously."""
    decision = decide(
        "trusted",
        "Write",
        {"file_path": raw},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize(
    "raw",
    [_TRAILING_DOT_PATH, _ADS_PATH],
    ids=["trailing_dot", "alternate_data_stream"],
)
def test_decide_trusted_mode_never_allows_the_round_5_canonicalized_self_modify_forms(
    raw,
):
    """Trailing-dot and ADS spellings resolve to a real self-surface match
    (not the ambiguous sentinel) -- they must still bubble to ask via the
    ordinary self-modify rule, never fall through to trusted mode's
    "allow the rest"."""
    decision = decide(
        "trusted",
        "Write",
        {"file_path": raw},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"
    assert decision.self_modify is True
    assert decision.self_modify_path == "backend/rag.py"


# G5 batch-11 fixup (critical 1): a Windows drive-root-relative absolute
# path (`\Users\...` / `/Users/...`, no drive letter, no `//` or `/??/`
# root, and NOT the single-letter Git-Bash `/c/...` form) used to fail the
# root-prefix comparison and return bare `None` -- "provably outside the
# repo" -- even though it names the real repo file, because on Windows such
# a path is relative to the CURRENT DRIVE and the CLI's cwd is always
# repo_root.
_DRIVE_ROOT_RELATIVE_BACKSLASH = r"\proj\theDAW\backend\rag.py"
_DRIVE_ROOT_RELATIVE_FORWARD = "/proj/theDAW/backend/rag.py"
_DRIVE_ROOT_RELATIVE_MIXED = r"\proj/theDAW\backend/rag.py"
_DRIVE_ROOT_RELATIVE_TRAVERSAL = r"\proj\theDAW\backend\..\backend\rag.py"


@pytest.mark.parametrize(
    "raw",
    [
        _DRIVE_ROOT_RELATIVE_BACKSLASH,
        _DRIVE_ROOT_RELATIVE_FORWARD,
        _DRIVE_ROOT_RELATIVE_MIXED,
        _DRIVE_ROOT_RELATIVE_TRAVERSAL,
    ],
    ids=["backslash", "forward", "mixed", "traversal"],
)
def test_drive_root_relative_path_normalises_to_repo_relative_posix(raw):
    result = self_modify_path("Edit", {"file_path": raw}, REPO_ROOT)
    assert result == "backend/rag.py"


@pytest.mark.parametrize(
    "raw",
    [
        _DRIVE_ROOT_RELATIVE_BACKSLASH,
        _DRIVE_ROOT_RELATIVE_FORWARD,
        _DRIVE_ROOT_RELATIVE_MIXED,
        _DRIVE_ROOT_RELATIVE_TRAVERSAL,
    ],
    ids=["backslash", "forward", "mixed", "traversal"],
)
def test_decide_trusted_mode_never_allows_a_drive_root_relative_self_write(raw):
    """The exact G5 batch-11 vulnerability: trusted mode used to ALLOW this
    outright (self_modify=False, reason "Trusted mode") because
    self_modify_path returned None for a drive-root-relative self-surface
    path."""
    decision = decide(
        "trusted",
        "Write",
        {"file_path": raw},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"
    assert decision.self_modify is True
    assert decision.self_modify_path == "backend/rag.py"


def test_drive_root_relative_path_decides_as_self_modify_through_bash():
    decision = decide(
        "trusted",
        "Bash",
        {"command": r"echo pwned > \proj\theDAW\backend\rag.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.self_modify is True
    assert decision.self_modify_path == "backend/rag.py"


def test_drive_root_relative_ask_mode_session_allow_still_asks_for_self_modify():
    """A session-allowed `Write` must NOT allow a drive-root-relative
    self-surface path -- the self-modify rule always re-bubbles regardless
    of sessionAllow. Before the fix, self_modify_path returned None for
    this spelling, so rule 4 (session_allow short-circuit) fired instead of
    the never-remembered self-modify card."""
    canonical = decide(
        "ask",
        "Write",
        {"file_path": "backend/rag.py"},
        session_allow={"Write"},
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert canonical.action == "ask"

    root_relative = decide(
        "ask",
        "Write",
        {"file_path": _DRIVE_ROOT_RELATIVE_BACKSLASH},
        session_allow={"Write"},
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert root_relative.action == "ask"
    assert root_relative.self_modify is True


def test_drive_root_relative_fix_does_not_affect_etc_passwd():
    result = self_modify_path("Edit", {"file_path": "/etc/passwd"}, REPO_ROOT)
    assert result is None


def test_drive_root_relative_fix_does_not_affect_git_bash_drive_path():
    result = self_modify_path(
        "Edit",
        {"file_path": "/c/proj/theDAW/backend/rag.py"},
        REPO_ROOT,
    )
    assert result == "backend/rag.py"


# --- G5 round 6 ------------------------------------------------------------
# Three bypasses demonstrated by the sixth independent audit: a `cd`-prefixed
# shell write, a bare `rm -rf <self-surface-dir>` (no trailing slash), and
# quoting spellings that defeat shell-token candidate extraction on the
# Python side. Plus a Python/TS normalization divergence for inputs that
# collapse to a bare drive letter.


@pytest.mark.parametrize(
    "command",
    [
        "cd backend && echo x > rag.py",
        "cd backend; echo x > rag.py",
        "pushd backend && echo x > rag.py",
    ],
)
def test_cd_or_pushd_prefixed_write_is_ambiguous_not_resolved(command):
    # G5 batch-11 (9th audit) item 5: a plain `cd`/`pushd` short-circuit now
    # reports the distinct AMBIGUOUS_CD_PATH sentinel, not the Win32-device/
    # UNC one -- same "ask, always" treatment, clearer reason.
    result = self_modify_path("Bash", {"command": command}, REPO_ROOT)
    assert result == AMBIGUOUS_CD_PATH


@pytest.mark.parametrize("mode", ["trusted", "accept_edits", "ask"])
def test_decide_asks_for_a_cd_prefixed_write_in_every_non_readonly_mode(mode):
    decision = decide(
        mode,
        "Bash",
        {"command": "cd backend && echo x > rag.py"},
        session_allow={"Bash"},
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


def test_decide_readonly_mode_still_denies_a_cd_prefixed_write():
    decision = decide(
        "readonly",
        "Bash",
        {"command": "cd backend && echo x > rag.py"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "deny"


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf backend/modules/assistant",
        "rm -rf frontend/src/orb-kit",
    ],
)
def test_bare_self_surface_directory_rm_is_self_modify(command):
    result = self_modify_path("Bash", {"command": command}, REPO_ROOT)
    assert result in ("backend/modules/assistant", "frontend/src/orb-kit")


def test_decide_trusted_mode_asks_for_a_bare_self_surface_directory_rm():
    decision = decide(
        "trusted",
        "Bash",
        {"command": "rm -rf backend/modules/assistant"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"
    assert decision.self_modify is True
    assert decision.self_modify_path == "backend/modules/assistant"


def test_self_surface_directory_with_trailing_slash_still_matches():
    """Regression guard: the round-6 fix must not break the existing
    trailing-slash spelling that already matched before this round."""
    result = self_modify_path(
        "Bash",
        {"command": "rm -rf backend/modules/assistant/"},
        REPO_ROOT,
    )
    assert result == "backend/modules/assistant"


@pytest.mark.parametrize(
    "command",
    [
        'echo x > "back""end"/rag.py',
        "echo x > 'back'end/rag.py",
    ],
)
def test_concatenated_and_split_quote_spellings_are_detected(command):
    assert self_modify_path("Bash", {"command": command}, REPO_ROOT) == "backend/rag.py"


def test_python_dash_c_open_call_with_comma_separated_args_is_detected():
    result = self_modify_path(
        "Bash",
        {"command": "python -c \"open('backend/rag.py','w')\""},
        REPO_ROOT,
    )
    assert result == "backend/rag.py"


def test_decide_trusted_mode_asks_for_a_concatenated_quote_write():
    decision = decide(
        "trusted",
        "Bash",
        {"command": 'echo x > "back""end"/rag.py'},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"
    assert decision.self_modify_path == "backend/rag.py"


def test_bare_drive_root_normalises_to_none_not_a_bogus_relative_path():
    """G5 round 6 item 4: `self_modify_path` must never surface the bogus
    relative path "C:" for input that collapses to a bare drive letter --
    it must resolve the same way the TypeScript port already does (outside
    the repo, i.e. not a self-modify match)."""
    result = self_modify_path("Edit", {"file_path": "/"}, REPO_ROOT)
    assert result is None


def test_bare_drive_root_decides_as_an_ordinary_allow_in_trusted_mode():
    decision = decide(
        "trusted",
        "Edit",
        {"file_path": "/"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.self_modify is False
    assert decision.self_modify_path is None
    assert decision.action == "allow"


# --- G5 batch-11 (7th audit) -------------------------------------------------
# The cd/pushd short-circuit was whitespace-sensitive and quote-blind (missed
# paren-glued and nested-shell spellings), the PowerShell aliases of cd were
# never covered, a backslash was always read as a path separator even for
# shell commands (where it can be a POSIX escape), the join-window bound was
# a countable evasion budget, and the cd short-circuit over-asked on every
# read-only `cd`-prefixed command including the ones CLAUDE.md documents.


@pytest.mark.parametrize(
    "command",
    [
        "(cd backend; echo x > rag.py)",
        "(pushd backend; echo x > rag.py; popd)",
    ],
)
def test_batch11_item1_paren_cd_spellings_are_ambiguous(command):
    # G5 batch-11 (9th audit) item 5: plain (non-nested-shell) `cd`/`pushd`
    # spellings report AMBIGUOUS_CD_PATH now; see the nested-shell variant
    # of this test below for the ones that still report AMBIGUOUS_WIN32_PATH.
    assert (
        self_modify_path("Bash", {"command": command}, REPO_ROOT) == AMBIGUOUS_CD_PATH
    )


@pytest.mark.parametrize(
    "command",
    [
        'bash -c "cd backend && echo x > rag.py"',
        "sh -c 'cd backend && echo x > rag.py'",
    ],
)
def test_batch11_item1_nested_shell_cd_spellings_are_ambiguous(command):
    assert (
        self_modify_path("Bash", {"command": command}, REPO_ROOT)
        == AMBIGUOUS_WIN32_PATH
    )


def test_batch11_item1_control_space_after_paren_still_ambiguous():
    """The pre-existing control: a space right after the paren was already
    caught by the old token-based check. Must not regress."""
    result = self_modify_path(
        "Bash", {"command": "( cd backend; echo x > rag.py )"}, REPO_ROOT
    )
    assert result == AMBIGUOUS_CD_PATH


@pytest.mark.parametrize(
    "command",
    [
        "chdir backend; echo x > rag.py",
        "Set-Location backend; Set-Content rag.py x",
        "sl backend; ni rag.py",
        "pushd backend; echo x > rag.py; popd",
        "popd; echo x > rag.py",
        "push-location backend; echo x > rag.py",
        "pop-location; echo x > rag.py",
    ],
)
def test_batch11_item2_every_powershell_cd_alias_is_ambiguous_when_writing(command):
    # G5 batch-11 (9th audit) item 5: plain cd-alias short-circuits report
    # AMBIGUOUS_CD_PATH now, not the Win32-device/UNC sentinel.
    assert (
        self_modify_path("Bash", {"command": command}, REPO_ROOT) == AMBIGUOUS_CD_PATH
    )


@pytest.mark.parametrize(
    "command",
    [
        r"echo x > back\end/rag.py",
        r"echo x > ba\ckend/rag.py",
    ],
)
def test_batch11_item3_backslash_escape_spellings_are_detected(command):
    result = self_modify_path("Bash", {"command": command}, REPO_ROOT)
    assert result == "backend/rag.py"


def test_batch11_item3_edit_kind_keeps_backslash_as_separator_only():
    """The EDIT kind must NOT gain the escape-reading variant -- a literal
    backslash in a file_path is always a Windows separator there."""
    result = self_modify_path("Write", {"file_path": r"backend\rag.py"}, REPO_ROOT)
    assert result == "backend/rag.py"


def test_batch11_item3_genuine_windows_drive_path_is_not_corrupted():
    r"""Guard for the fix's own collateral: a real ``C:\...`` shell argument
    must still resolve via the separator reading, not get mangled by the new
    backslash-removal variant into a bogus drive-relative string."""
    result = self_modify_path(
        "Bash",
        {"command": r"python gen.py --out=C:\proj\theDAW\backend\rag.py"},
        REPO_ROOT,
    )
    assert result == "backend/rag.py"


@pytest.mark.parametrize(
    "command",
    [
        'echo x > "b""a""c""k""e""n""d"/rag.py',  # 8 fragments
        'echo x > "ba""ck""en""d"/rag.py',  # 5 fragments (was the old window=6 edge)
        'echo x > "b""a""c""k""e""n""d""/""r""a""g"".""p""y"',  # 11+ fragments
    ],
)
def test_batch11_item4_unbounded_quote_fragment_splits_are_detected(command):
    assert self_modify_path("Bash", {"command": command}, REPO_ROOT) == "backend/rag.py"


@pytest.mark.parametrize(
    "command",
    [
        "ls backend/ rag.py",
        "git add backend/ rag.py",
    ],
)
def test_batch11_item5_real_space_join_no_longer_fabricates_a_match(command):
    """These two are genuine false positives from the old real-space joining
    (a directory argument glued to an unrelated filename token). Removing
    the join (item 4) must make them resolve to no self-surface match."""
    assert self_modify_path("Bash", {"command": command}, REPO_ROOT) is None


@pytest.mark.parametrize(
    "command",
    [
        "cd frontend && npm run build",
        "cd frontend && npm run lint:classes",
        "cd frontend && npx tsc --noEmit",
        "cd backend && uv run pytest",
        "cd VST-Foundry-UI/VST-UI-FOUNDRY && npx vitest run",
        "cd /tmp && ls",
    ],
)
def test_batch11_item6_documented_claude_md_cd_commands_allow_in_trusted(command):
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


@pytest.mark.parametrize(
    "command",
    [
        "cd backend && rm -rf rag.py",
        "cd backend && echo x > rag.py",
        "chdir backend && git checkout rag.py",
        "cd backend; sed -i s/x/y/ rag.py",
    ],
)
def test_batch11_item6_cd_plus_write_signal_still_asks_in_trusted(command):
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "cdk",
        "npx cdk synth",
        "procd",
        "--cd",
        "notes-cd.txt",
        "cd-rom.iso",
        "cdimage",
        "CD=1 make",
    ],
)
def test_batch11_cd_word_boundary_false_positives_still_allow(command):
    """Token-lookalikes of cd (substring or adjacent-punctuation) must never
    trigger the short-circuit."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


# ---------------------------------------------------------------------------
# G5 batch-11 (8th audit) findings
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "cd backend && python - <<'EOT'\nopen('rag.py','w')\nEOT",
        "cd backend && node -e \"require('fs').writeFileSync('rag.py','')\"",
        "cd backend && perl -i -pe 's/a/b/' rag.py",
        "cd backend && sed -i.bak s/a/b/ rag.py",
        "cd backend && install -m 644 /dev/null rag.py",
        "cd backend && patch < p.diff",
        "cd backend && git apply p.diff",
        "cd backend && tar xf a.tar",
        "cd backend && gcc -o rag.py x.c",
        "cd backend && Copy-Item a rag.py",
        "cd backend && New-Item -Force rag.py",
        "cd backend && Remove-Item rag.py",
        "cd backend && ri rag.py",
    ],
)
def test_batch11r8_item1_proven_writers_ask_in_trusted(command):
    """Round 8 CRITICAL: the write-signal BLACKLIST the round-7 `cd` fix
    used missed every one of these live-proven writers (none are redirects
    or in the old write-word list). The ALLOWLIST replacement must ask for
    all of them, in trusted mode, where the blacklist previously allowed."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "cd frontend && npm run build",
        "cd frontend && npm run lint:classes",
        "cd frontend && npx tsc --noEmit",
        "cd backend && uv run pytest",
        "cd VST-Foundry-UI/VST-UI-FOUNDRY && npx vitest run",
        "cd /tmp && ls",
    ],
)
def test_batch11r8_item1_documented_claude_md_shapes_still_allow_in_trusted(command):
    """The allowlist replacement must not regress the six CLAUDE.md shapes
    the round-7 `cd` fix was written to unblock in the first place."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


@pytest.mark.parametrize(
    "command",
    [
        "tar -C backend -xf a.tar && sh",
        "make -C src ; bash",
        "git -C x log | sh",
        "sh -C foo",
    ],
)
def test_batch11r8_item2_uppercase_dash_c_excluded_from_nested_shell(command):
    """Round 8 item 2 (parity): a bare uppercase `-C` (tar/make/git's own
    flag, not a nested-shell `-c`/`-Command` invocation) must never be
    mistaken for a nested-shell flag. These commands contain no `cd`/`pushd`
    token either, so with no nested-shell match they resolve through the
    ordinary candidate-path scan and find no self-surface path."""
    assert not p._has_nested_shell(command)


def test_batch11r8_item3_drive_root_traversal_does_not_false_positive():
    """Round 8 item 3: `..` walking past the drive letter must clamp at the
    drive root (matching the TypeScript port), not pop the drive segment
    itself and land on a bogus repo-relative-looking path."""
    root = Path("C:/proj/repo")
    assert (
        self_modify_path("Edit", {"file_path": "C:/a/../../backend/rag.py"}, root)
        is None
    )


def test_batch11r8_item4_doubled_quotes_still_resolve():
    """Round 8 item 4 (parity): `.strip("\"'")` removes ALL surrounding
    quote characters, not just one pair, so a doubled-quote path must still
    resolve to the same self-surface match."""
    assert (
        self_modify_path("Edit", {"file_path": '""backend/rag.py""'}, REPO_ROOT)
        == "backend/rag.py"
    )


@pytest.mark.parametrize(
    "command",
    [
        "/bin/sh -c 'cd backend && rm -rf rag.py'",
        "sh -c 'cd backend; rm -rf rag.py'",
    ],
)
def test_batch11r8_item5_absolute_path_shell_interpreter_detected(command):
    """Round 8 item 5 (note, folded in): the interpreter prefix boundary
    class previously omitted `/`, so `/bin/sh -c '...'` was invisible to
    the nested-shell check even with `sh` and `-c` both present."""
    assert p._has_nested_shell(command)


@pytest.mark.parametrize(
    "command",
    [
        "cdk",
        "npx cdk synth",
        "procd",
        "--cd",
        "notes-cd.txt",
        "cd-rom.iso",
        "cdimage",
        "CD=1 make",
        "my.sl",
    ],
)
def test_batch11r8_cd_word_boundary_false_positives_still_no_match(command):
    """Regression guard: none of these must match `_CD_RAW_RE` as a `cd`
    word -- in particular `my.sl` must stay unmatched (a `.`-preceded `sl`
    is NOT added to the prefix boundary class, unlike the shell-interpreter
    fix in item 5, because doing so would misfire here)."""
    assert p._CD_RAW_RE.search(command) is None


# ---------------------------------------------------------------------------
# G5 batch-11 (9th audit) findings
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "cd backend && uv run pytest ; echo x > rag.py",
        "cd backend && uv run pytest ; rm -f rag.py",
        "cd backend && uv run pytest && rm -rf modules/assistant",
        "cd backend && uv run pytest > rag.py",
        "cd backend && uv run pytest | tee rag.py",
        "cd backend && uv run pytest ; git checkout -- .",
        "cd server && uv run pytest ; rm -f permissions.ts",
        "cd backend && npm run lint>rag.py",
        "cd backend && npm run lint>>rag.py",
        "cd backend && npm run lint;>rag.py",
        "cd server && npm run lint>permissions.ts",
    ],
)
def test_batch11r9_item1_2_metachar_bypasses_ask_in_trusted(command):
    r"""Round 9 CRITICAL: `uv\s+run\s+pytest(?:\s+\S+)*` fullmatched
    ANY tail once the `uv run pytest` head was present (a universal
    wildcard), and `lint\S*` greedily swallowed a glued redirect. Both let
    a second command or a redirect ride through the allowlist while the
    fullmatch still nominally succeeded. Every one of these must ask, in
    trusted mode, never allow."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "cd frontend && npm test",
        "cd backend && npm run test:sing",
        "cd backend && uv run ruff format --check .",
    ],
)
def test_batch11r9_item3_widened_tails_now_allow_in_trusted(command):
    """Round 9 MAJOR: the allowlist over-asked on realistic post-`cd`
    commands, including CLAUDE.md's own documented `cd frontend && npm
    test` shape. These must resolve to allow.

    G5 round 12 (11th audit) note: this list previously also included
    `cd /tmp && ls -la`, `cd /tmp && cat rag.py`, `cd backend && git log
    --oneline -5`, and `cd backend && git status --short` -- all four
    carried a flag/argument, which the round-12 exact-literal-invocation
    rewrite (see the comment above `_KNOWN_READ_ONLY_TAILS`) no longer
    admits. They are asserted as `ask` in
    ``test_batch11r12_item2_3_flag_bearing_variants_of_allowlisted_tails_ask_in_trusted``
    below, which supersedes their prior inclusion here.

    G5 batch-11 (10th audit) note: `cd backend && npm run fix:classes` and
    `cd backend && uv run ruff check .` were removed from this list -- the
    10th audit proved both to be writers (`fix:classes` rewrites files
    under the `orb-kit` self-surface glob; bare `ruff check .` is one
    `--fix` token away from writing) that this allowlist must never grant.
    They are asserted as `ask` in
    ``test_batch11r10_item1_2_3_proven_writers_ask_in_trusted`` below,
    which supersedes their prior inclusion here."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


def test_batch11r9_item3_bare_cd_no_tail_allows_in_trusted():
    """Round 9 MAJOR: a bare `cd backend` with no trailing command carries
    no write risk at all and must resolve to allow, not the ambiguous
    'ask' the short-circuit previously gave every `cd`."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": "cd backend"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


def test_batch11r9_item5_cd_ambiguous_reason_names_the_cause():
    """Round 9 MINOR: the `cd` short-circuit's ask reason must name the
    actual cause instead of reusing the unrelated Win32 device/UNC
    wording."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": "cd backend && echo hi"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"
    assert (
        decision.reason == "Command changes directory; target path cannot be resolved"
    )
    assert "Win32" not in decision.reason


# ---------------------------------------------------------------------------
# G5 batch-11 (10th audit) findings
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        # item 1: ruff's default write modes must ask, not just its --fix flags.
        "cd backend && uv run ruff format .",
        "cd backend && uv run ruff check --fix .",
        # item 2: git --output creates/truncates the named file.
        "cd backend && git diff --output=modules/assistant/permissions.py HEAD",
        "cd backend && git show --output=modules/assistant/permissions.py HEAD --stat",
        "cd backend && git diff --output=rag.py HEAD~1 HEAD --stat",
        # item 3: npm/pnpm/yarn subcommands other than `run <safe-script>`,
        # and `run <script>` with args that redirect its output elsewhere.
        "cd frontend && npm run fix:classes",
        "cd frontend && npm install",
        "cd frontend && npm install evil-pkg",
        "cd frontend && npm ci",
        "cd frontend && npm exec -- rimraf .",
        "cd frontend && yarn add evil",
        "cd frontend && pnpm dlx anything",
        "cd frontend && npm run build --prefix ../backend",
        "cd frontend && npm run build -- --outDir ../../backend",
        # item 5: pytest importing an arbitrary file/module outside tests/.
        "cd backend && uv run pytest evil.py",
        "cd backend && uv run pytest conftest.py",
    ],
)
def test_batch11r10_item1_2_3_proven_writers_ask_in_trusted(command):
    """Round 10 CRITICALs 1-3 and MAJOR 5: each of these was live-proven to
    write a file (including the assistant's own self-surface, for
    `fix:classes`, `--output`, and bare `ruff format`/`ruff check --fix`)
    while resolving `allow` under the round-9 allowlist. Every one of these
    must ask, in trusted mode, never allow.

    G5 round 12 (11th audit) note: bare `cd backend && uv run ruff check .`
    was removed from this list -- round 10 excluded it out of caution
    because its then flag-based allowlist could not structurally tell "no
    `--fix` today" from "no `--fix` ever" (`--fix` was "one token away").
    Round 12's exact-literal rewrite (`_KNOWN_READ_ONLY_TAILS`) makes that
    distinction moot: `uv run ruff check .` is a documented CLAUDE.md
    hard-rule-2 command; it is admitted because it never writes to a REPO
    SOURCE FILE without `--fix` (G5 round 13 (12th audit) item 5: it DOES
    write/update its own `.ruff_cache/` directory by default -- `ruff
    clean`, per Ruff's own CLI reference fetched via GitMCP, exists
    specifically to "clear any caches" ruff commands leave behind -- but
    `.ruff_cache/` is never a self-surface glob, so the `allow` verdict is
    unaffected), and -- being an exact literal with no argument tail
    admitted at all --
    can never have `--fix` appended to it. It is now correctly asserted as
    `allow` in ``test_batch11r10_surviving_positives_still_allow_in_trusted``
    above."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "cd backend&&../tools/x.sh",
        "cd backend&&make",
        "cd backend&&./evil.sh",
        "cd backend&&rm -rf .",
    ],
)
def test_batch11r10_item4_separator_glued_cd_asks_in_trusted(command):
    r"""Round 10 CRITICAL: `_CD_BARE_RE`'s directory argument was `\S+`,
    which is greedy over non-whitespace and swallowed a separator-glued
    second command whole (no space around `&&`), so the bare-`cd`
    short-circuit treated the whole line as a risk-free directory change
    and let it fall through to trusted's unconditional allow. Every one of
    these must ask."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "cd backend&&./evil.sh&&ls",
        "cd backend&&../tools/wipe.sh&&cat",
        "cd backend&&evil.exe&&ls",
        "cd backend&&C:/evil.bat&&cat",
        "cd backend&&./evil.sh&&npm run build",
    ],
)
def test_batch11r12_item1_separator_glued_cd_with_trailing_allowlisted_command_still_asks_in_trusted(  # noqa: E501
    command,
):
    r"""Round 12 (11th audit) CRITICAL: `_CD_TO_SAFE_TAIL_RE`'s directory
    argument had the identical `\S+` flaw round 10 fixed in `_CD_BARE_RE`
    but never carried over here -- greedy over non-whitespace, it swallowed
    a separator-glued second command whole, so the capture group (meant to
    be the WHOLE tail) was only the LAST segment, and only that segment was
    checked against the allowlist. Proven live: `cd backend&&./evil.sh&&ls`
    resolved `allow` (tail captured as bare `ls`) on both ports and wrote an
    arbitrary-execution marker. Every one of these -- a separator-glued `cd`
    followed by an arbitrary command and THEN a real allowlisted literal --
    must ask, regardless of what the allowlisted literal at the end is."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


def test_batch11r10_item4_bare_cd_with_space_still_allows_in_trusted():
    """Round 10 CRITICAL (regression guard): the item 4 fix must not
    reopen the round-9 item-3 bare-`cd`-with-a-space case it was built to
    allow."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": "cd backend && ls"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


@pytest.mark.parametrize(
    "command",
    [
        "cd backend && uv run pytest",
        "cd backend && uv run pytest tests/test_inference.py",
        "cd backend && uv run pytest --save-audio",
        "cd backend && uv run ruff check",
        "cd backend && uv run ruff check .",
        "cd backend && uv run ruff format --check",
        "cd backend && git status",
        "cd backend && git log",
        "cd backend && git diff",
        "cd backend && git show",
        "cd frontend && npm run lint",
        "cd frontend && npm run lint:scripts",
        "cd frontend && npm run build",
        "cd VST-Foundry-UI/VST-UI-FOUNDRY && npm run lint",
        "cd VST-Foundry-UI/VST-UI-FOUNDRY && npm test",
        "cd VST-Foundry-UI/VST-UI-FOUNDRY && npx vitest run",
    ],
)
def test_batch11r10_surviving_positives_still_allow_in_trusted(command):
    """Round 10 regression guard, revised for round 12's exact-literal
    rewrite: the allowlist must not over-ask on the exact literal
    invocations `_KNOWN_READ_ONLY_TAILS` admits -- CLAUDE.md's documented
    ruff/pytest/npm shapes and the bare read-only primitives (`git`
    subcommands, `ls`, `cat`), none of which carry a flag or argument.

    G5 round 12 (11th audit) note: the round-10 spellings this test used to
    assert (`uv run pytest -q`, `uv run pytest tests -q`, `uv run ruff check
    --diff .`, `uv run ruff format --diff .`, `git diff HEAD`, `git show
    HEAD --stat`) are exactly the CRITICAL 2/3 flag-tolerance holes this
    round closes -- see
    ``test_batch11r12_item2_3_flag_bearing_variants_of_allowlisted_tails_ask_in_trusted``
    below, which supersedes their prior inclusion here and asserts them as
    `ask` instead."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


@pytest.mark.parametrize(
    "command",
    [
        # Finding 2 (CRITICAL): every proven pytest output-path flag.
        "cd backend && uv run pytest -q",
        "cd backend && uv run pytest tests -q",
        "cd backend && uv run pytest tests/test_assistant_permissions.py -q",
        "cd backend && uv run pytest --junitxml=rag.py",
        "cd backend && uv run pytest --debug=rag.py",
        "cd backend && uv run pytest --basetemp=modules",
        "cd backend && uv run pytest --cov-report=xml:rag.py",
        "cd backend && uv run pytest -ocache_dir=modules/assistant/junk",
        "cd backend && uv run pytest -pmyplug",
        # Finding 3 (CRITICAL): every proven ruff output-path flag, including
        # with a --diff/--check preview flag also present.
        "cd backend && uv run ruff check --diff -o rag.py .",
        "cd backend && uv run ruff check --diff --output-file=rag.py .",
        "cd backend && uv run ruff format --check -o rag.py .",
        "cd backend && uv run ruff check --diff --cache-dir=modules/assistant/x",
        "cd backend && uv run ruff check --diff .",
        "cd backend && uv run ruff format --diff .",
        "cd backend && uv run ruff format .",
        # git with any argument at all, including the previously-admitted
        # `--output`-free forms -- exact-literal admits only the bare form.
        "cd backend && git diff HEAD",
        "cd backend && git show HEAD --stat",
        "cd backend && git log --oneline -5",
        "cd backend && git status --short",
        # Bare read-only primitives with any argument at all.
        "cd backend && ls -la",
        "cd backend && cat rag.py",
    ],
)
def test_batch11r12_item2_3_flag_bearing_variants_of_allowlisted_tails_ask_in_trusted(
    command,
):
    """Round 12 (11th audit) CRITICALs 2/3: `uv run pytest`'s flag pattern
    and `uv run ruff check/format --check|--diff`'s trailing-argument tail
    each admitted an output-path-naming flag, proven live to truncate,
    overwrite, or (`--basetemp`) recursively DELETE
    `backend/modules/assistant/` -- this policy module's own directory.

    The fix replaces the per-tool flag regex with a closed set of exact
    literal invocations (`_KNOWN_READ_ONLY_TAILS`): every one of these
    commands -- the exact same base invocation as an allowlisted literal,
    plus ANY appended flag or argument -- must ask, in trusted mode, never
    allow. This is the PROPERTY the finding requires tested, not just the
    specific spellings that were proven live."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "cd backend && ls\u2028rm -rf .",
        "cd backend && ls\u2029rm -rf .",
    ],
)
def test_batch11r10_item6_unicode_line_separator_in_tail_asks_in_trusted(command):
    """Round 10 MINOR: U+2028/U+2029 are now rejected by
    `_TAIL_METACHAR_RE` on both ports (previously only rejected by the
    TypeScript port, where `.` treats them as line terminators, giving the
    two ports divergent verdicts on the same command)."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize(
    "tail",
    sorted(p._KNOWN_READ_ONLY_TAILS),
)
def test_batch11r12_item4_every_allowlisted_literal_with_appended_argument_asks_in_trusted(
    tail,
):
    """Round 12 (11th audit) finding 4: the property, not just the proven
    spellings. `_KNOWN_READ_ONLY_TAILS` is a closed set of EXACT literal
    invocations with no argument tail admitted at all -- for every single
    one of them, appending ANY token must ask, never allow, because the
    exact-string comparison can never match a string that is longer than
    the literal it is compared against."""
    command = f"cd backend && {tail} --anything-at-all"
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


# ---------------------------------------------------------------------------
# G5 round 13 (12th audit) findings
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        # Proven-live exploit shapes: a scratch package.json/conftest.py
        # under an attacker-controlled directory executes on `npm run
        # build`/`uv run pytest`/etc.
        "cd /tmp/evil && npm run build",
        "cd C:/evil && npm test",
        "cd ../../evil && npx vitest run",
        "cd ~ && npm run build",
        "cd .. && npm run lint",
    ],
)
def test_batch11r13_item1_project_code_tails_outside_closed_dirs_ask_in_trusted(
    command,
):
    """Round 13 (12th audit) MAJOR item 1: the allowlist bounded the
    command STRING but not the CODE THAT RUNS -- nine of the twenty-one
    literals execute code read from the `cd` target directory
    (`package.json` scripts, a discovered test suite and its
    `conftest.py`), and that directory was never validated. Every one of
    these must ask, in trusted mode, now that `_PROJECT_CODE_READ_ONLY_TAILS`
    entries require the directory to be in `_SAFE_PROJECT_DIRS`."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "cd /tmp && ls",
        "cd /tmp/evil && cat",
        "cd ~ && git status",
        "cd .. && git log",
    ],
)
def test_batch11r13_item1_inert_tails_allow_from_any_directory(command):
    """Round 13 item 1: inertness doesn't depend on location -- the four
    bare `ls`/`cat`/`git status`/`git log`/`git diff`/`git show` shapes
    stay admitted from ANY directory, unlike the nine project-code tails
    above."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


@pytest.mark.parametrize(
    "command",
    [
        "cd backend\x00 && npm test",
        "cd backend\x00 && ls",
    ],
)
def test_batch11r13_item3_nul_in_directory_argument_asks_in_trusted(command):
    """Round 13 MINOR item 3: NUL (``\x00``) added to the directory
    argument's excluded-character class in both ``_CD_BARE_RE`` and
    ``_CD_TO_SAFE_TAIL_RE``. Not reachable live (neither Node's
    ``child_process`` nor Python's ``subprocess`` will spawn an argv
    containing it), but the class must not silently admit the one code
    point it previously could not already represent."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


def test_batch11r13_item4_bom_in_cd_tail_asks_in_trusted():
    r"""Round 13 MINOR item 4: U+FEFF (BOM/ZWNBSP) is in JavaScript's ``\s``
    but not Python's -- with the shared explicit ``_WS`` class replacing
    ``\s``, neither port treats it as a separator, so ``npm\ufeffrun
    lint`` never normalises to the admitted literal ``npm run lint`` on
    either port."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": "cd frontend && npm\ufeffrun lint"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"


def test_batch11r13_item4_nel_in_cd_directory_allows_in_trusted():
    r"""Round 13 MINOR item 4: U+0085 (NEL) is in Python's ``\s`` but not
    JavaScript's -- with the shared explicit ``_WS`` class replacing
    ``\s``, neither port treats it as a separator, so it is accepted as an
    ordinary (if unusual) character inside the directory argument on both
    ports, matching the TypeScript port's ``allow``."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": "cd back\u0085end&&ls"},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


@pytest.mark.parametrize(
    "command",
    [
        "ls -la",
        "cat backend/rag.py",
        "head -40 backend/rag.py",
        "wc -l backend/rag.py",
        "git status --short",
        "git log --oneline -5",
        "git diff HEAD~1",
        "git show HEAD --stat",
    ],
)
def test_batch11r13_item2_bare_read_commands_with_arguments_allow_in_trusted(command):
    """Round 13 MAJOR item 2: a bare (no ``cd``) invocation of one of the
    eight inert read commands with an argument used to over-ask, because
    every token in a shell command was treated as a possible write target
    regardless of which command it belonged to (naming a self-surface file
    as a plain READ argument was indistinguishable from naming it as a
    WRITE target), and ``HEAD~1``-style git refs independently tripped the
    unrelated Windows short-name ambiguity heuristic. None of these eight
    commands can write to an argument they are given, so none of them
    should ask."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "allow"


@pytest.mark.parametrize(
    "command",
    [
        "git diff --output=backend/rag.py HEAD",
        "git show --output=backend/rag.py HEAD --stat",
        "git diff -o backend/rag.py",
        "cat backend/rag.py > backend/rag.py",
        "cat backend/rag.py; rm -rf .",
    ],
)
def test_batch11r13_item2_write_primitive_and_metachar_stay_excluded(command):
    """Round 13 MAJOR item 2: the argument-bearing bypass must not open a
    new hole -- ``--output``/``-o`` on ``git diff``/``git show`` (the one
    write primitive that flag surface has) and any shell metacharacter
    (redirect, second command) must still fall through to the ordinary
    candidate-path scan, which correctly flags the self-surface write."""
    decision = decide(
        "trusted",
        "Bash",
        {"command": command},
        session_allow=set(),
        deny_count=0,
        repo_root=REPO_ROOT,
    )
    assert decision.action == "ask"
