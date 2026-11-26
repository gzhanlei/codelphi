import packageInfo from "../../package.json";

/** 客户端的版本号，随提案上报（client.clientVersion）。取自 package.json。 */
export const CLIENT_VERSION: string = packageInfo.version;

/** 分析管线的版本：管线本身的步骤或顺序变了就升它。 */
export const CLIENT_PIPELINE_VERSION = "client-pipeline-1";

/** 影响规则的版本（修订稿 §4.3、§5.5）。 */
export const CLIENT_IMPACT_RULES_VERSION = "impact-v1";
