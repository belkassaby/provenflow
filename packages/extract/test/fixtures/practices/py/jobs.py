import json


def load(text):
    try:
        return json.loads(text)
    except ValueError:
        pass
    return None


def run(job, dry_run: bool):
    # job.start()
    # job.wait(timeout=30)
    if dry_run:
        return None
    return job
