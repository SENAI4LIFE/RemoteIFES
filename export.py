import subprocess

message = input("Commit message [update]: ").strip()
if not message:
    message = "update"

subprocess.run(["git", "add", "-A"], check=True)

commit = subprocess.run(
    ["git", "commit", "-m", message],
    text=True,
)

if commit.returncode != 0:
    print("Nothing to commit.")

subprocess.run(["git", "push", "origin", "main"], check=True)

print("Done.")