import { createHyphenator } from '../chunk-ZW2EUTPS.js';

// src/hyphenation/it.ts
var packed = "0.a3p2n 2nti1 53m2n 1bio1 1c2 2a4p3s 2ircu2m1 2ontro1 1d2 2i2s3cine 1e2x1eu 1fran2k3 3ee3 1h2 1j2 1k2 1li3p2sa 1narco1 1opto1 2rto3p2 1p2s 2ara1 2h2l 4r 2oli3p2 2re1 1re1i2scr 1sha2re3 2u2b3lu 6r 1t2 2ran2s3c 8d 8l 8n 8p 8r 8t 1wa2g3n 2el2t1 1z2 01b 1c 1d 1f 1g 1h 1j 1k 1l 1m 1n 1p 1q 1r 1s2 1t 1v 1w 1x 1z 02'2 1at. 1b' 2. 2b 2c 2d 2f 2m 2n 2p 2s 2t 2v 1c' 2. 2b 2c 2d 2f 2h''. 4. 3. 3b 3h 3n 2k 2m 2n 2q 2s 2t 2z 1d' 2. 2b 2d 2g 2l 2m 2n 2p 2s 2t 2v 2w 1f' 2. 2b 2f 2g 2n 2s 2t 1g' 2. 2b 2d 2f 2g 2h2t 2m 2p 2s 2t 2v 2w 2z 1h' 2. 2b 2d 2h 2m 2n 2r 2v 1j' 2. 1k' 2. 2f 2g 2k 2m 2s 2t 1l'' 3. 2. 23f2 2b 2c 2d 2g 2k 2l 2m 2n 2p 2q 2r 2s 2t 2v 2w 2z 1m' 2. 2b 2c 2f 2l 2m 2n 2p 2q 2r 2s 2t 2v 2w 1n' 2. 2b 2c 2d 2f 2g 2heit 2k 2l 2m 2n 2p 2q 2r 2s 2t 2v 2z 1p' 2. 2d 2n 2p 2s 2t 2z 1q' 2. 2q 1r' 2. 2b 2c 2d 2f 2g 2k 2l 2m 2n 2p 2q 2r 2s 2t 2v 2w 2x 2z 1s3p2n 3s 2h' 3. 3m 2tb 3c 3d 3f 3g 3m 3n 3p 3s 3t 3v 2z 1t'' 3. 2. 2b 2c 2d 2f 2g 2h. 2m 2n 2p 2t 2v 2w 2zk 1v'' 3. 2. 2c 2v 1w' 2. 21y 1x' 2. 2b 2c 2f 2h 2m 2p 2t 2w 1z'' 3. 2. 2b 2d 2l 2n 2p 2s 2t 2v 2z 03p2ne 3sic 1t2sch 04s'' 3. 2. 0a1ia 3e 3o 3u 2uo 2ya 0b2l 2r 0c2h 2l 2r 1h2r 0d2r 0e1iu 12w 0f2l 2r 0g2h 2l 2n 2r 0h2l 1i3p2n 0k2h 2l 2r 0l2h 2j 0n2g3n 2s3fer 0o1ia 3e 3o 3u 0p2h 2l 2r 0r2h 2t2s3 0s4s3m 0t2h 2l 2r 2s 2t3s 2z 1z2s 0v2l 2r 0w2h 1a2r 0y1i 2ou";
var exceptions = "";
var hyphenateIt = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 2
});
export { hyphenateIt };