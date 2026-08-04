# OnlyOffice fonts

Piwork does not generate, cache, validate, or distribute OnlyOffice font
assets. Fonts are built, licensed, attested, and deployed with the immutable
runtime in `agentbridges-ai/onlyoffice-browser`. Piwork consumes only the npm
client API and its pinned runtime descriptor. The former local font-generation
commands are retired and fail closed.
