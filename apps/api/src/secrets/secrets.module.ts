import { Module } from "@nestjs/common";
import { ConnectionCryptoService } from "./connection-crypto.service";
import { ConnectionKeyProvider } from "./connection-key-provider";

@Module({
  providers: [ConnectionKeyProvider, ConnectionCryptoService],
  exports: [ConnectionKeyProvider, ConnectionCryptoService]
})
export class SecretsModule {}
