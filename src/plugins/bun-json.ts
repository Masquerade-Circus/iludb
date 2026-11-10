import { fileAdapter } from "./file-storage";
import { ConflictError, PersistenceError } from "../persistence";

const bunJSON = Object.assign(fileAdapter(Bun), { ConflictError, PersistenceError });
export default bunJSON;
