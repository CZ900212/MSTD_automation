// 敏感文本检测的逐模式样本集：egress 与持久记忆共用的服务端裁决规则。
// 源码注释明言"改 long_numeric 阈值前先过 sensitive-text 测试样本"——本文件即样本。
import { describe, it, expect } from "vitest";
import { scanSensitiveText, redactSensitiveText, SENSITIVE_TEXT_REDACTION } from "../server/safety/sensitive-text.mjs";

describe("scanSensitiveText 六模式命中/不命中样本", () => {
  it("private_key:BEGIN/END 块命中,含 RSA 变体与未闭合块(截断泄漏也要拦)", () => {
    expect(scanSensitiveText("-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----")).toContain("private_key");
    expect(scanSensitiveText("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----")).toContain("private_key");
    expect(scanSensitiveText("-----BEGIN PRIVATE KEY-----\nMIIabc（消息被截断")).toContain("private_key"); // 未闭合仍命中
    expect(scanSensitiveText("公钥无妨:-----BEGIN PUBLIC KEY-----")).not.toContain("private_key");
  });

  it("aws_access_key:AKIA+16 位大写字母数字命中;长度/前缀不符不命中", () => {
    expect(scanSensitiveText("泄漏了 AKIAIOSFODNN7EXAMPLE 这个键")).toContain("aws_access_key");
    expect(scanSensitiveText("AKIAIOSFODNN7EXAMPL")).not.toContain("aws_access_key");  // 15 位不足
    expect(scanSensitiveText("BKIAIOSFODNN7EXAMPLE")).not.toContain("aws_access_key"); // 前缀不符
  });

  it("jwt:三段 base64url 命中;两段不命中", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
    expect(scanSensitiveText(`token 是 ${jwt}`)).toContain("jwt");
    expect(scanSensitiveText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0")).not.toContain("jwt");
  });

  it("long_numeric_identifier 边界:13 位时间戳/11 位手机号放行;14-19 位命中;20 位数字串不命中", () => {
    expect(scanSensitiveText("时间戳 1784175803160")).not.toContain("long_numeric_identifier");   // 13 位
    expect(scanSensitiveText("联系 13812345678")).not.toContain("long_numeric_identifier");        // 11 位
    expect(scanSensitiveText("卡号 6222020200112233")).toContain("long_numeric_identifier");       // 16 位银行卡
    expect(scanSensitiveText("身份证 110101199003078234")).toContain("long_numeric_identifier");   // 18 位
    expect(scanSensitiveText("12345678901234")).toContain("long_numeric_identifier");              // 下界 14
    expect(scanSensitiveText("1234567890123456789")).toContain("long_numeric_identifier");         // 上界 19
    expect(scanSensitiveText("12345678901234567890")).not.toContain("long_numeric_identifier");    // 20 位整串越界
  });

  it("bearer_token 与 credential_assignment 既有样本回归", () => {
    expect(scanSensitiveText("Authorization: Bearer abcdefghijklmnop1234")).toContain("bearer_token");
    expect(scanSensitiveText("api_key: super-secret-value-1")).toContain("credential_assignment");
    expect(scanSensitiveText("密码：hunter2hunter2")).toContain("credential_assignment");
    expect(scanSensitiveText("普通业务文本,无敏感内容")).toEqual([]);
  });
});

describe("redactSensitiveText", () => {
  it("多模式同文本共存:全部替换,matches 排序去重", () => {
    const text = "key AKIAIOSFODNN7EXAMPLE 卡号 6222020200112233";
    const r = redactSensitiveText(text);
    expect(r.redacted).toBe(true);
    expect(r.matches).toEqual(["aws_access_key", "long_numeric_identifier"]);
    expect(r.text).not.toContain("AKIA");
    expect(r.text).not.toContain("6222");
    expect(r.text.split(SENSITIVE_TEXT_REDACTION).length - 1).toBe(2);
  });

  it("自定义 replacement 生效;干净文本原样返回", () => {
    expect(redactSensitiveText("卡号 6222020200112233", "[REDACTED]").text).toContain("[REDACTED]");
    const clean = redactSensitiveText("没有秘密");
    expect(clean).toMatchObject({ text: "没有秘密", redacted: false, matches: [] });
  });
});
