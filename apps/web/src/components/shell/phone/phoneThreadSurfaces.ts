/*
 * The frozen phone tier's thread surfaces, as one on-demand chunk: the chat
 * route and its composer only reach them through `lazyPhoneThreadSurfaces`, so
 * desktop and tablet threads never download them. Every surface the phone
 * thread renders is here, so a phone opens the thread with one extra request.
 */
export { MessageActionsSheet } from "../../chat/MessageActionsSheet";
export { PhoneModelSheet } from "../../chat/PhoneModelSheet";
export { PhoneSessionPolicyControl } from "../../chat/PhoneSessionPolicySheet";
export { PhoneThreadAppBar } from "./PhoneThreadAppBar";
export { PhoneThreadDock } from "./PhoneThreadDock";
export { PhoneOverviewSheet, PhoneWorkSurfaceSheet } from "./PhoneWorkSurface";
