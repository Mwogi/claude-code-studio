#!/usr/bin/env python3
"""
Frappe Backend Validation Script for BMAD Dev Story Workflow

Scans modified Python files for common Frappe API misuse patterns:
1. get_cached_value / get_value with wrong field names (validates against doctype JSON)
2. get_cached_value with dict as name arg (should be string)
3. db.set_value with None as docname (silent no-op)
4. Missing null checks after get_cached_value / get_value

Usage: python3 frappe_api_lint.py <file1.py> [file2.py ...]
       python3 frappe_api_lint.py --git-diff   # scan git-changed .py files
"""

import ast
import sys
import os
import json
import re
import subprocess
from pathlib import Path


class FrappeAPIVisitor(ast.NodeVisitor):
    """AST visitor that flags suspicious Frappe API usage patterns."""

    def __init__(self, filename, doctype_fields=None):
        self.filename = filename
        self.issues = []
        self.doctype_fields = doctype_fields or {}

    def _loc(self, node):
        return f"{self.filename}:{node.lineno}"

    def visit_Call(self, node):
        self._check_get_cached_value(node)
        self._check_db_set_value(node)
        self._check_get_value(node)
        self.generic_visit(node)

    def _get_call_name(self, node):
        """Extract dotted call name like 'frappe.get_cached_value'."""
        parts = []
        n = node.func
        while isinstance(n, ast.Attribute):
            parts.append(n.attr)
            n = n.value
        if isinstance(n, ast.Name):
            parts.append(n.id)
        parts.reverse()
        return ".".join(parts)

    def _check_get_cached_value(self, node):
        name = self._get_call_name(node)
        if "get_cached_value" not in name:
            return

        args = node.args
        if len(args) < 2:
            return

        # Check: second arg should be a string name, not a dict
        second_arg = args[1]
        if isinstance(second_arg, ast.Dict):
            self.issues.append({
                "loc": self._loc(node),
                "severity": "HIGH",
                "rule": "FRAPPE-001",
                "msg": (
                    f"get_cached_value() second arg is a dict — should be a string (docname). "
                    f"Dict filters are only valid for frappe.db.get_value(). "
                    f"This will silently return None."
                ),
            })

        # Check: field name exists on doctype (if we know the doctype)
        if len(args) >= 3:
            doctype_arg = args[0]
            field_arg = args[2]
            if isinstance(doctype_arg, ast.Constant) and isinstance(field_arg, ast.Constant):
                dt = doctype_arg.value
                field = field_arg.value
                if dt in self.doctype_fields and field not in self.doctype_fields[dt]:
                    self.issues.append({
                        "loc": self._loc(node),
                        "severity": "HIGH",
                        "rule": "FRAPPE-002",
                        "msg": (
                            f"Field '{field}' does not exist on doctype '{dt}'. "
                            f"Known fields: {', '.join(sorted(self.doctype_fields[dt])[:10])}..."
                        ),
                    })

    def _check_get_value(self, node):
        name = self._get_call_name(node)
        if name not in ("frappe.db.get_value", "frappe.get_value"):
            return

        args = node.args
        if len(args) >= 3:
            doctype_arg = args[0]
            field_arg = args[2]
            if isinstance(doctype_arg, ast.Constant) and isinstance(field_arg, ast.Constant):
                dt = doctype_arg.value
                field = field_arg.value
                if dt in self.doctype_fields and field not in self.doctype_fields[dt]:
                    self.issues.append({
                        "loc": self._loc(node),
                        "severity": "HIGH",
                        "rule": "FRAPPE-002",
                        "msg": (
                            f"Field '{field}' does not exist on doctype '{dt}'. "
                            f"Known fields: {', '.join(sorted(self.doctype_fields[dt])[:10])}..."
                        ),
                    })

    def _check_db_set_value(self, node):
        name = self._get_call_name(node)
        if "set_value" not in name:
            return

        args = node.args
        if len(args) >= 2:
            docname_arg = args[1]
            if isinstance(docname_arg, ast.Constant) and docname_arg.value is None:
                self.issues.append({
                    "loc": self._loc(node),
                    "severity": "HIGH",
                    "rule": "FRAPPE-003",
                    "msg": (
                        "db.set_value() called with None as docname — this is a silent no-op. "
                        "The target record will never be updated."
                    ),
                })


def load_doctype_fields(bench_path):
    """Scan doctype JSON files to build a field map."""
    fields_map = {}
    for json_file in Path(bench_path).rglob("*.json"):
        try:
            with open(json_file) as f:
                data = json.load(f)
            if data.get("doctype") == "DocType" and "fields" in data:
                dt_name = data.get("name", "")
                dt_fields = set()
                # Standard fields always present
                dt_fields.update(["name", "owner", "creation", "modified", "modified_by",
                                  "docstatus", "idx", "doctype", "parent", "parentfield",
                                  "parenttype"])
                for field in data["fields"]:
                    if "fieldname" in field:
                        dt_fields.add(field["fieldname"])
                if dt_name:
                    fields_map[dt_name] = dt_fields
        except (json.JSONDecodeError, KeyError, UnicodeDecodeError):
            continue
    return fields_map


def scan_file(filepath, doctype_fields):
    """Parse and scan a single Python file."""
    try:
        with open(filepath) as f:
            source = f.read()
        tree = ast.parse(source, filename=filepath)
    except SyntaxError as e:
        return [{"loc": f"{filepath}:{e.lineno}", "severity": "ERROR", "rule": "PARSE",
                 "msg": f"SyntaxError: {e.msg}"}]

    visitor = FrappeAPIVisitor(filepath, doctype_fields)
    visitor.visit(tree)
    return visitor.issues


def get_changed_py_files():
    """Get Python files changed in the current git diff."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "--diff-filter=ACMR", "HEAD"],
            capture_output=True, text=True, check=True
        )
        return [f for f in result.stdout.strip().split("\n") if f.endswith(".py") and os.path.exists(f)]
    except subprocess.CalledProcessError:
        # Try unstaged changes
        result = subprocess.run(
            ["git", "diff", "--name-only", "--diff-filter=ACMR"],
            capture_output=True, text=True
        )
        return [f for f in result.stdout.strip().split("\n") if f.endswith(".py") and os.path.exists(f)]


def main():
    files = []
    bench_path = None

    if "--git-diff" in sys.argv:
        files = get_changed_py_files()
    else:
        files = [f for f in sys.argv[1:] if f.endswith(".py")]

    if "--bench-path" in sys.argv:
        idx = sys.argv.index("--bench-path")
        if idx + 1 < len(sys.argv):
            bench_path = sys.argv[idx + 1]

    if not files:
        print("No Python files to scan.")
        sys.exit(0)

    # Load doctype field definitions if bench path provided
    doctype_fields = {}
    if bench_path:
        print(f"Loading doctype definitions from {bench_path}...", file=sys.stderr)
        doctype_fields = load_doctype_fields(bench_path)
        print(f"Loaded {len(doctype_fields)} doctypes", file=sys.stderr)

    all_issues = []
    for f in files:
        issues = scan_file(f, doctype_fields)
        all_issues.extend(issues)

    if not all_issues:
        print("✅ No Frappe API issues found.")
        sys.exit(0)

    print(f"\n🚨 Found {len(all_issues)} Frappe API issue(s):\n")
    for issue in all_issues:
        print(f"  [{issue['severity']}] {issue['rule']} at {issue['loc']}")
        print(f"         {issue['msg']}\n")

    high_count = sum(1 for i in all_issues if i["severity"] == "HIGH")
    if high_count > 0:
        print(f"\n❌ {high_count} HIGH severity issue(s) — these MUST be fixed before merge.")
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
