"""Load the existing server-only key without embedding it in Docker Config.Env."""
import os
import stat
import sys


def read_key(path):
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 4096:
                raise ValueError()
            if os.name != "nt" and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600):
                raise ValueError()
            value = stream.read(4097).decode("ascii")
            # Only the file's optional final line ending is removed, not arbitrary whitespace.
            value = value.removesuffix("\n").removesuffix("\r")
            if not value or len(value) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value):
                raise ValueError()
            return value
    except (OSError, UnicodeError, ValueError):
        raise ValueError("Invalid credential file") from None


def main():
    if sys.argv[1:] != ["daemon"]:
        raise ValueError("Unsupported controller command")
    env = dict(os.environ)
    env["MINIMAX_CN_API_KEY"] = read_key("/run/secrets/minimax-api-key")
    os.execve("/app/agent-compose", ["/app/agent-compose", "daemon"], env)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        print("Controller startup failed: check the private key file and entrypoint configuration.", file=sys.stderr)
        sys.exit(1)
