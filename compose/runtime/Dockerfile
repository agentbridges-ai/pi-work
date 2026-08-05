FROM node:22.19.0-bookworm-slim

ARG BUN_VERSION=1.3.9
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=/usr/local/bun/bin:/usr/local/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tini unzip bubblewrap socat ripgrep tar \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /usr/local/bun \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}" \
  && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun

RUN groupadd --gid 65532 piwork \
  && useradd --uid 65532 --gid 65532 --create-home --home-dir /home/piwork --shell /usr/sbin/nologin piwork \
  && mkdir -p /var/lib/piwork/data /run/piwork-runtime /etc/piwork \
  && chown -R 65532:65532 /var/lib/piwork /run/piwork-runtime /etc/piwork

WORKDIR /workspace
COPY --chown=piwork:piwork package.json /workspace/package.json
COPY --chown=piwork:piwork web/package.json web/bun.lock /workspace/web/
COPY --chown=piwork:piwork packages/design-tokens/package.json /workspace/packages/design-tokens/package.json
COPY --chown=piwork:piwork packages/ui/package.json /workspace/packages/ui/package.json
COPY --chown=piwork:piwork packages/ui-patterns/package.json /workspace/packages/ui-patterns/package.json
RUN cd /workspace/web && bun install --backend copyfile --frozen-lockfile
RUN chown -R 65532:65532 /workspace/web/node_modules

COPY --chown=piwork:piwork web /workspace/web
COPY --chown=piwork:piwork packages /workspace/packages
COPY --chown=piwork:piwork scripts /workspace/scripts

# This root-owned helper is selected only by the server's typed
# compose-nested SRT policy.  Native Linux uses sandbox-runtime's normal
# bubblewrap --dev path.
COPY --chown=root:root compose/runtime/piwork-bwrap-wrapper.js /usr/local/bin/piwork-bwrap
RUN chmod 0555 /usr/local/bin/piwork-bwrap

WORKDIR /workspace/web
USER piwork:piwork
ENTRYPOINT ["/usr/bin/tini", "--"]
