import subprocess

subprocess.run(
    ["git", "pull", "origin", "main"],
    check=True,
)

print("Done.")