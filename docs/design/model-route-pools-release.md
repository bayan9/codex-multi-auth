# Routing release scope

Keep personal configuration, credential files, native probe logs,
local repair manifests, account identities and private model references outside
any commit or pull request.

## Proposed title

Preserve native desktop features with capability-aware inference routing

## Proposed description

App binding should keep the real desktop login available for remote-control
pairing and other native features while independently selecting eligible inference
credentials. Build the model catalog from enabled credentials and preserve native
reasoning and speed controls. Route each request only to credentials supporting
its model and settings, with ordered failover inside its selected privacy pool.

Explicit API and ZDR entries remain isolated from subscription routing. Opt-in
checks probe minimal Responses/tool compatibility and refresh the served catalog;
short-lived runtime rejection evidence handles changes between checks. Responses
WebSockets use the same routing and authentication boundary as HTTP, with bounded
connection-local continuations and no replay after generation starts.

Validation: 6,393 full-suite tests passed; two reproducible base wrapper failures
and one intermittent helper stress failure remain. The stress case subsequently
passed in isolation, but remains a release caveat. Typecheck, lint, build, production
audit and development-audit allowlist pass. Production advisories are remediated.
Serial creates and explicit rejection of unsupported steering controls remain
transport limits. A new live desktop acceptance test was not run for this draft.

Voice is a separate experimental follow-up and is excluded from the tested text
release. It requires a successful native/public Live handshake and microphone
acceptance before enabling. Project/section routing and in-app indicators are
outside the requested scope.

## Reviewable change groups

- API credential storage and interactive visibility choices; catalog union and
  eligibility; native effort/speed metadata; check-time probes and refresh.
- Responses WebSocket transport and connection-local state; narrowly classified
  runtime rejections and strict-pin accounting; transport/security regression tests.
- Experimental voice adapter: keep out of publication and installation pending
  Live access/protocol verification. Do not include voice source/schema/hooks or
  its tests when constructing the text-only release artifact.

Do not publish a monolithic working-tree diff containing the experimental voice
integration. The local text artifact was built from a separate source snapshot
with that integration excluded and tested in that exact form.
