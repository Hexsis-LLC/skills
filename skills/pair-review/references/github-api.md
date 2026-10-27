# GitHub API Calls

What `scripts/pair-review.mjs` sends for you, and the calls it leaves to you. `<repo>` is `owner/name` and `<n>` is the pull request number (both are in `meta.json`).

## Reads

```sh
gh pr view <n> --json number,title,body,baseRefName,headRefOid,author,reviewDecision
gh api user --jq .login                                   # who a post will appear as
gh issue view <n> --json title,body,comments,labels      # a spec issue
gh api repos/<repo>/pulls/<n>/reviews/<review-id>/comments --paginate --jq length   # count after posting
```

Review threads (`threads`) come from GraphQL, because REST has no resolved state:

```graphql
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 100) { nodes { databaseId author { login } body createdAt } }
        }
      }
    }
  }
}
```

Run it with `gh api graphql --paginate --slurp -f query=... -F owner=... -F name=... -F number=...`. `line` is null once the anchored code is gone. `originalLine` is where the comment was posted.

## Writes (only on the user's word)

| Action | Call |
| --- | --- |
| Post the review | `gh api --method POST repos/<repo>/pulls/<n>/reviews --input review-payload.json` |
| Resolve a thread (`resolve`) | `gh api graphql -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' -f id=<thread node id>` |
| Reply on a thread (`reply`) | `gh api --method POST repos/<repo>/pulls/<n>/comments/<first comment databaseId>/replies -f body=...` |
| Open an issue | `gh issue create --title ... --body ... --label ...`, with the labels from the repository's issue-tracker doc |
| Close an issue folded into the pull request | `gh issue close <n> --reason "not planned" --comment "Folded into #<pr>: ..."` |
| Mark an issue blocked by another (any repository) | `ID=$(gh api repos/<other>/issues/<m> --jq .id)` then `gh api --method POST repos/<repo>/issues/<n>/dependencies/blocked_by -F issue_id=$ID` |

## Review payload

```json
{
  "commit_id": "<head sha>",
  "event": "REQUEST_CHANGES",
  "body": "<review-body.md>",
  "comments": [
    { "path": "lib/a.dart", "line": 14, "side": "RIGHT", "body": "..." },
    { "path": "lib/a.dart", "start_line": 12, "start_side": "RIGHT", "line": 14, "side": "RIGHT", "body": "..." }
  ]
}
```

- GitHub rejects the whole review (422) if any comment's line is outside the diff for `commit_id`. `check` catches this first.
- A multi-line comment's `start_line` and `line` must be in the same hunk.
- A ` ```suggestion ` block replaces exactly `start_line`..`line` (or `line` alone). It may hold more or fewer lines than it replaces, and an empty block deletes them. To show a fence inside a suggestion, open the block with four backticks.
- One review holds every comment, blocking and FYI. Its verdict applies to the whole review, not to each comment.
- The pull request's author can't request changes on their own pull request; use `COMMENT`.
