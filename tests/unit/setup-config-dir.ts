import fs from "fs";
import os from "os";
import path from "path";

// endpoint approvals are kept in a per-user folder (see eventraConfigDir): point it at a throwaway
// folder so no test ever writes to the real ~/.config/eventra
process.env.EVENTRA_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-config-dir-"));
