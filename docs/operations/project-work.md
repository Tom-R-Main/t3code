# Work that survives a turn

This fork's project work tools keep an outcome and its accepted requirements in the
T3 database. Use them when work spans runs, owners, or dependencies. A small edit
that fits in one turn does not need a work record.

The conversation still carries the user's intent and authorization. A work record
does not grant new permissions. It makes the selected requirements, assignment and
evidence available when a run ends or a different agent continues the work.

## Start and assign

Ask the agent to create work with `t3_work`: an objective, authorized scope,
attributed source excerpts, acceptance criteria and any existing work dependencies.
Name the promised boundary: a checked change, a merged PR and a working installation
are different outcomes. Each criterion names the evidence it requires.

For example, delivering individual files and a ZIP needs separate criteria. A
passing build cannot satisfy the ZIP criterion when that criterion requires an
observed download. Keep fixture results, runtime observations and model reviews
distinct. Include only context the receiving agent is permitted to read; source
references do not cause T3 to open or upload their files. Oversized packets are
rejected rather than silently shortened.

Use `t3_work_read` to obtain the current packet and version. The executing agent
claims that version with `t3_work`. T3 derives its project, thread and active run
from the authenticated invocation and saves an immutable assignment.

Claiming does **not** launch an agent. To delegate, send the selected packet and
work identity through T3's existing delegation tools, retain the returned dispatch
receipt, and have the child read and claim the current work. The child must belong
to the same project. A reply saying "I'll proceed" is not a dispatch receipt.

## Continue and recover

Read the work before continuing after interruption, a dependency change or a
handoff. Mutations require the current version. A material requirements change
creates a new revision and invalidates the current assignment and its completion
evidence. The creating thread owns revisions, cancellation and release for another
owner; an executing agent cannot silently rewrite its acceptance criteria.

Record a wait with its release condition. Recording a wait or updating a dependency
does not schedule a wake: use the existing T3 watcher, background task or explicit
handoff for that. On wake, read current state and reconcile the preceding run before
resuming or reassigning. A cancelled work record does not stop a running provider;
use the existing runtime cancellation control as well when stopping execution is
part of the request.

Use a stable request ID for each intended mutation. If its reply is lost, repeat
that exact request to recover its stored result. Changing the request under the
same ID is refused. A replay is a historical receipt, so read current state before
choosing the next action. This prevents duplicate work-record changes; it does not
make external actions such as sending an email exactly once.

## Prove and finish

Record evidence against a criterion and the current assignment, with its artifact,
artifact revision, observed result and attribution. Completion checks each required
evidence kind against the supplied artifact revision and checks dependencies again.
Old assignment evidence and missing criteria cannot complete current work. A
finished provider turn does not complete its work record.

These checks establish evidence coverage and ownership, not the truth of an agent's
claims. Artifact references and model-review attribution are supplied by the agent;
T3 does not execute the test or independently authenticate a reviewer. Human
acceptance requirements remain pending: this first MCP surface deliberately has no
agent operation that can approve them. Do not remove a required human criterion to
make completion pass.

Work lives with the environment's existing SQLite state and follows its backup and
recovery policy. This version has no work-board UI, cross-project assignment, new
scheduler or automatic installation into another T3 environment.
