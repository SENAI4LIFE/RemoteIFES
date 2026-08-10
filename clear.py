import shutil
import subprocess
import sys
from pathlib import Path

def run_command(command, allow_fail=False):
    try:
        subprocess.run(command, shell=True, check=not allow_fail)
    except subprocess.CalledProcessError:
        sys.exit(1)

if shutil.which("git") is None:
    print("git is not installed or not on PATH. Install git and try again.")
    sys.exit(1)

repo_dir = Path(__file__).resolve().parent
check = subprocess.run(["git", "-C", str(repo_dir), "rev-parse", "--is-inside-work-tree"], capture_output=True)
if check.returncode != 0:
    subprocess.run(["git", "-C", str(repo_dir), "init"], check=True)

run_command(f"git -C {repo_dir} branch -D latest_branch", allow_fail=True)
run_command(f"git -C {repo_dir} checkout --orphan latest_branch")
run_command(f"git -C {repo_dir} add -A")
run_command(f"git -C {repo_dir} commit -m 'first commit'")
run_command(f"git -C {repo_dir} branch -D main", allow_fail=True)
run_command(f"git -C {repo_dir} branch -m main")

remote_check = subprocess.run(["git", "-C", str(repo_dir), "remote", "get-url", "origin"], capture_output=True)
if remote_check.returncode != 0:
    print("\n No 'origin' remote is configured for this repo.")
    remote_url = input("Enter the GitHub repo URL to use as origin: ").strip()
    if remote_url:
        subprocess.run(["git", "-C", str(repo_dir), "remote", "add", "origin", remote_url], check=True)
    else:
        print("No URL provided. Cancelled.")
        sys.exit(1)

print("\n This action will overwrite the history on GitHub.")
confirm = input("Type 'yes' to force push: ")

if confirm.lower() == 'yes':
    run_command(f"git -C {repo_dir} push -f origin main")
else:
    print("Cancelled.")