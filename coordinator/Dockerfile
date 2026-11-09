# ---------------------------------------------------------------------------
# Rust mesh coordinator  --  multi-stage production build
# ---------------------------------------------------------------------------

# ---- build stage ---------------------------------------------------------
FROM rust:1.85-alpine AS build

RUN apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static

WORKDIR /build

# Copy manifests first for layer caching
COPY Cargo.toml Cargo.lock ./
COPY crates/coord-core/Cargo.toml crates/coord-core/Cargo.toml
COPY crates/coord-noise/Cargo.toml crates/coord-noise/Cargo.toml
COPY crates/coord-proto/Cargo.toml crates/coord-proto/Cargo.toml
COPY crates/coord-netmap/Cargo.toml crates/coord-netmap/Cargo.toml
COPY crates/coord-acl/Cargo.toml crates/coord-acl/Cargo.toml
COPY crates/coord-store/Cargo.toml crates/coord-store/Cargo.toml
COPY crates/coord-api/Cargo.toml crates/coord-api/Cargo.toml
COPY crates/coord-federation/Cargo.toml crates/coord-federation/Cargo.toml
COPY crates/coord-server/Cargo.toml crates/coord-server/Cargo.toml

# Create stub lib.rs files so cargo can resolve the workspace
RUN for d in crates/*/; do mkdir -p "$d/src" && echo "" > "$d/src/lib.rs"; done && \
    mkdir -p crates/coord-server/src && echo "fn main() {}" > crates/coord-server/src/main.rs

# Pre-build dependencies (cached unless Cargo.toml/lock change)
RUN cargo build --release --package coord-server 2>/dev/null || true

# Copy real source and migrations
COPY crates/ crates/
COPY migrations/ migrations/

# Build the real binary
RUN cargo build --release --package coord-server

# ---- runtime stage -------------------------------------------------------
FROM alpine:3.21

RUN apk add --no-cache tini ca-certificates

COPY --from=build /build/target/release/coord-server /usr/local/bin/coord-server

EXPOSE 9443

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["coord-server"]
