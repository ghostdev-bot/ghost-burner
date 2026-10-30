// Minimal, dependency-free Metaplex Token Metadata helpers (read + BurnV1).
import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

export const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const enc = new TextEncoder();
const dec = new TextDecoder();

export const TokenStandard = { NonFungible: 0, FungibleAsset: 1, Fungible: 2, NonFungibleEdition: 3, ProgrammableNonFungible: 4, ProgrammableNonFungibleEdition: 5 };

export function metadataPda(mint) {
  return PublicKey.findProgramAddressSync([enc.encode('metadata'), TOKEN_METADATA_PROGRAM_ID.toBytes(), new PublicKey(mint).toBytes()], TOKEN_METADATA_PROGRAM_ID)[0];
}
export function editionPda(mint) {
  return PublicKey.findProgramAddressSync([enc.encode('metadata'), TOKEN_METADATA_PROGRAM_ID.toBytes(), new PublicKey(mint).toBytes(), enc.encode('edition')], TOKEN_METADATA_PROGRAM_ID)[0];
}

// Parses the Metadata account prefix we need. Returns null if not a Metadata account.
export function parseMetadata(data) {
  try {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let o = 0;
    const key = u8[o++];
    if (key !== 4) return null; // Key::MetadataV1
    const updateAuthority = new PublicKey(u8.subarray(o, o + 32)); o += 32;
    const mint = new PublicKey(u8.subarray(o, o + 32)); o += 32;
    const str = () => { const n = dv.getUint32(o, true); o += 4; if (n > 1000) throw new Error('bad str'); const s = dec.decode(u8.subarray(o, o + n)).replace(/\0/g, '').trim(); o += n; return s; };
    const name = str(), symbol = str(), uri = str();
    o += 2; // seller fee bps
    if (u8[o++] === 1) { const n = dv.getUint32(o, true); o += 4 + n * 34; } // creators
    o += 2; // primarySaleHappened, isMutable
    if (u8[o++] === 1) o += 1; // editionNonce
    let tokenStandard = null;
    if (o < u8.length && u8[o++] === 1) tokenStandard = u8[o++];
    let collection = null;
    if (o < u8.length && u8[o++] === 1) { const verified = u8[o++] === 1; collection = { verified, key: new PublicKey(u8.subarray(o, o + 32)) }; o += 32; }
    return { updateAuthority, mint, name, symbol, uri, tokenStandard, collection };
  } catch { return null; }
}

// Edition account key byte: 1 = EditionV1 (print), 2 = MasterEditionV1, 6 = MasterEditionV2.
export function editionKind(data) {
  if (!data || !data.length) return null;
  const k = data[0];
  if (k === 6 || k === 2) return 'master';
  if (k === 1) return 'print';
  return null;
}

// Token Metadata BurnV1 (discriminator 41, BurnArgs::V1 = 0, amount u64) for a
// standard (non-programmable) master-edition NFT. Closes the token account,
// metadata and master edition; rent goes to the owner (authority).
export function createBurnNftV1Instruction({ owner, mint, tokenAccount, collectionMint = null }) {
  const P = TOKEN_METADATA_PROGRAM_ID;
  const none = { pubkey: P, isSigner: false, isWritable: false };
  const w = (pubkey) => ({ pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true });
  const data = new Uint8Array(10);
  data[0] = 41; data[1] = 0;
  new DataView(data.buffer).setBigUint64(2, 1n, true);
  return new TransactionInstruction({
    programId: P,
    keys: [
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: true }, // authority
      collectionMint ? w(metadataPda(collectionMint)) : none,               // collectionMetadata
      w(metadataPda(mint)),                                                 // metadata
      w(editionPda(mint)),                                                  // edition (master)
      w(mint),                                                              // mint
      w(tokenAccount),                                                      // token
      none, none, none, none, none,                                         // masterEdition*, editionMarker, tokenRecord
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: typeof Buffer !== 'undefined' ? Buffer.from(data) : data,
  });
}
