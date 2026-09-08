# Multi-stage build for backend/auth-service.
#
# NOTE on the Windows dev quirk documented in build-backend.bat: that quirk
# (git-bash's link.exe shadowing MSVC's) is purely a Windows-host cargo
# problem. Inside this Linux container we build with the standard
# x86_64-unknown-linux-gnu target using rustc's normal (non-MSVC, non-MSVC-
# conflicting) toolchain — no equivalent issue exists here, so no special
# flags/toolchain override are needed in this Dockerfile.

FROM rust:1.82-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy the whole backend workspace (Cargo.toml/Cargo.lock + auth-service) so
# workspace-relative paths resolve correctly.
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/auth-service ./auth-service

RUN cargo build --release --manifest-path auth-service/Cargo.toml

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --shell /usr/sbin/nologin noschat

WORKDIR /app
COPY --from=builder /build/target/release/auth-service /app/auth-service
COPY backend/auth-service/migrations /app/migrations

USER noschat
ENV RUST_LOG=info
EXPOSE 4000

ENTRYPOINT ["/app/auth-service"]
