# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security tab
of this repository), not in a public issue. You will get an answer within a week.

## What matters most

ProvenFlow runs on other people's code in CI. Reports about any of these are especially welcome:

- the GitHub Action running pull-request code with a token or secret it should not have (the
  analysis of a fork's pull request must stay on its read-only token; `review-post.yml` posts its
  review from the base repository's own code);
- the review file of a fork (`provenflow-review.json`) being able to post anything other than a
  review of the same pull request and commit (`pflow post-review` checks both);
- the server (`pflow` editor backend) reading or writing outside the folders it was given, or
  accepting LLM settings or folder paths from anything other than localhost;
- an LLM key reaching a log, a report or a pull request.

## Supply chain

The Action and the workflows pin every third-party action to a commit, and OpenSSF Scorecard runs
on the repository (`.github/workflows/scorecard.yml`).
