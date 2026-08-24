// Package identity 负责身份与令牌链路（设计 §5，单应用单 client）：
// Chandler JWKS 校验（iss/aud/exp）、sub → member/org/unit 解析
// （短缓存 + disable 主动失效）、X-Org-Id / X-Unit-Id 归属校验
// （绝不接受模型填写）。
package identity
