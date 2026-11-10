import { fileAdapter } from "./file-storage";
import { ConflictError, PersistenceError } from "../persistence";

const nodeJSON = Object.assign(fileAdapter(), { ConflictError, PersistenceError });
export default nodeJSON;
