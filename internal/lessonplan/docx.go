package lessonplan

import (
	"archive/zip"
	"bytes"
	"fmt"
	"strings"
)

const (
	contentTypesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

	relsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

	docRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

	stylesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="240" w:after="240"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="44"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/></w:rPr>
  </w:style>
</w:styles>`
)

// WriteDocx 把教案写成教师可打开的 Word，不是讲稿逐页复述。
func WriteDocx(p *Plan) ([]byte, error) {
	if p == nil {
		return nil, ErrEmpty
	}
	var body strings.Builder
	body.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	body.WriteString(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`)
	writeP(&body, "Title", p.Title+" 教案")
	writeHeading(&body, "Heading1", "一、教学目标")
	writeItems(&body, p.Goals)
	writeHeading(&body, "Heading1", "二、教学重难点")
	writeP(&body, "Normal", "重点")
	writeItems(&body, p.Focus)
	writeP(&body, "Normal", "难点")
	writeItems(&body, p.Hard)
	writeHeading(&body, "Heading1", "三、教学方法")
	writeItems(&body, p.Methods)
	writeHeading(&body, "Heading1", "四、教学过程")
	for i, s := range p.Process {
		head := fmt.Sprintf("%s%s", circleNum(i), s.Name)
		if s.Title != "" {
			head += "（第 " + s.Pages + " 页 · " + s.Title + "）"
		}
		writeHeading(&body, "Heading2", head)
		if t := strings.TrimSpace(s.Teacher); t != "" {
			writeP(&body, "Normal", "教师活动："+t)
		}
		if t := strings.TrimSpace(s.Student); t != "" {
			writeP(&body, "Normal", "学生活动："+t)
		}
		if t := strings.TrimSpace(s.Intent); t != "" {
			writeP(&body, "Normal", "设计意图："+t)
		}
	}
	if s := strings.TrimSpace(p.Script); s != "" {
		writeHeading(&body, "Heading1", "五、教学讲稿")
		writeP(&body, "Normal", s)
	}
	if len(p.Drift) > 0 {
		writeHeading(&body, "Heading1", "课件对照")
		writeItems(&body, p.Drift)
	}
	body.WriteString(`</w:body></w:document>`)

	buf := new(bytes.Buffer)
	zw := zip.NewWriter(buf)
	files := map[string]string{
		"[Content_Types].xml":          contentTypesXML,
		"_rels/.rels":                  relsXML,
		"word/_rels/document.xml.rels": docRelsXML,
		"word/styles.xml":              stylesXML,
		"word/document.xml":            body.String(),
	}
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write([]byte(data)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeHeading(b *strings.Builder, style, text string) {
	writeP(b, style, text)
}

func writeItems(b *strings.Builder, items []string) {
	if len(items) == 0 {
		writeP(b, "Normal", "（无）")
		return
	}
	for _, it := range items {
		writeP(b, "Normal", "• "+it)
	}
}

func writeP(b *strings.Builder, style, text string) {
	fmt.Fprintf(b, `<w:p><w:pPr><w:pStyle w:val="%s"/></w:pPr>`, xmlEscape(style))
	for i, line := range strings.Split(text, "\n") {
		if i > 0 {
			b.WriteString(`<w:r><w:br/></w:r>`)
		}
		fmt.Fprintf(b, `<w:r><w:t xml:space="preserve">%s</w:t></w:r>`, xmlEscape(line))
	}
	b.WriteString(`</w:p>`)
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	return s
}
