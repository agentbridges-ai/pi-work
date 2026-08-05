FROM node:22.19.0-bookworm-slim

ARG BUN_VERSION=1.3.9
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=/usr/local/bun/bin:/usr/local/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tini unzip \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /usr/local/bun \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}" \
  && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun

RUN groupadd --gid 65532 piwork \
  && useradd --uid 65532 --gid 65532 --create-home --home-dir /home/piwork --shell /usr/sbin/nologin piwork

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
COPY --chown=piwork:piwork compose /workspace/compose

WORKDIR /workspace/web
RUN chmod 0755 /workspace/compose/web-entrypoint.sh /workspace/compose/source-entrypoint.sh /workspace/compose/migrate-entrypoint.sh
USER piwork:piwork
ENTRYPOINT ["/usr/bin/tini", "--"]
