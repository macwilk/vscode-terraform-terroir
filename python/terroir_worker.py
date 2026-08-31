#!/usr/bin/env python3
import json
import os
import sys

# Grab the real stdout before anything we call has a chance to print to it,
# then point sys.stdout at stderr so stray writes from terroir or a plugin
# (print(), a misconfigured logging handler, ...) can't corrupt the protocol
# stream. All protocol output goes through _stdout directly.
_stdout = sys.stdout
sys.stdout = sys.stderr


def _write(obj):
    _stdout.write(json.dumps(obj, separators=(",", ":")))
    _stdout.write("\n")
    _stdout.flush()


def _error(exc):
    return {"type": type(exc).__name__, "message": str(exc)}


def render_dir(req):
    dir_path = req.get("dir")
    env = req.get("env")

    if not dir_path or not env:
        return {"ok": False, "error": {"type": "ValueError", "message": "'dir' and 'env' are required"}}

    if not os.path.isdir(dir_path):
        return {"ok": False, "error": {"type": "NotADirectoryError", "message": "not a directory: {}".format(dir_path)}}

    prev_cwd = os.getcwd()
    prev_environ = dict(os.environ)

    try:
        os.chdir(dir_path)
        os.environ["CAPITALRX_ENVIRONMENT"] = env
        os.environ["CAPITALRX_ENVIRONMENT_PREFIX"] = "" if env == "prod" else "{}-".format(env)

        try:
            import terroir.app as terroir_app

            app = terroir_app.App()
        except Exception as exc:
            return {"ok": False, "error": _error(exc)}

        files = {}
        errors = {}

        for name in sorted(n for n in os.listdir(".") if n.endswith(".tf")):
            try:
                with open(name, "rt") as fp:
                    original = fp.read()

                rewritten = app.module_rewriter.rewrite(original) if app.module_rewriter else original
                rendered = app.render(name, {"os": os})

                files[name] = {"rewritten": rewritten, "rendered": rendered}
            except Exception as exc:
                errors[name] = _error(exc)

        return {"ok": True, "files": files, "errors": errors}
    finally:
        os.chdir(prev_cwd)
        os.environ.clear()
        os.environ.update(prev_environ)


def handle(req):
    op = req.get("op")

    if op == "ping":
        return {"ok": True, "pong": True}
    elif op == "render_dir":
        return render_dir(req)
    elif op == "shutdown":
        return {"ok": True}
    else:
        return {"ok": False, "error": {"type": "ValueError", "message": "unknown op {!r}".format(op)}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _write({"id": None, "ok": False, "error": _error(exc)})
            continue

        req_id = req.get("id")

        try:
            resp = handle(req)
        except Exception as exc:
            resp = {"ok": False, "error": _error(exc)}

        resp["id"] = req_id
        _write(resp)

        if req.get("op") == "shutdown":
            break


if __name__ == "__main__":
    main()
