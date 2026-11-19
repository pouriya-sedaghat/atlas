Official source: https://github.com/openstreetmap/OSM-binary

Vendored upstream revision: `9f01ad3ece9737503a059d58749e02c9008d5699`.
The upstream file bytes were fetched from that tree and the Git blob identities
were verified with `git hash-object` against the approved Part 1B brief:

| File | Git blob SHA-1 | SHA-256 |
| --- | --- | --- |
| osmformat.proto | 311e8cef6d25db5883e35eff0c729cb73a9a38f0 | 5120dad564e717cf0b2bcf4b49d62c7180dc8b148084aa6b9f069a5e916027bc |
| fileformat.proto | 7392143c46bf301a2452e06065e8ae8590bed163 | eff8c3868b7fbf29a1ef9902933bd55a957c4e87ccfc490166fbe573ee173775 |

Both source files retain the complete copyright notice and MIT license.
`LICENSE` reproduces that same upstream license.

Generated using `grpcio-tools==1.78.0` (`libprotoc 31.1`, generated Python
protobuf version `6.31.1`). Production runtime is pinned to `protobuf==6.33.5`.
The generated code checks runtime compatibility on import. Regenerate from the
repository root in the pinned Python image with this build-only dependency:

```sh
python -m pip install grpcio-tools==1.78.0 protobuf==6.33.5
python -m grpc_tools.protoc -Iatlas_verification/proto \
  --python_out=atlas_verification/proto \
  atlas_verification/proto/fileformat.proto \
  atlas_verification/proto/osmformat.proto
```

Reproducible generated SHA-256 values:

* fileformat_pb2.py: `c7ec23b4f5743d8bfc7c760f284e1e87c240d536bf6189cbf784b8f7bc9a685a`
* osmformat_pb2.py: `7b2698a0d61ad90cb325c74b0955a67fa6c6d4bdeb163ef7abe085215475e91d`

The compiler is not required or installed in the verifier runtime image.
