// Package extract 从教师上传的材料中抽出纯文本，供 LLM / PPTCreator content 使用。
// 支持 text/markdown、docx、pdf；扫描件或无文字层的 PDF 会得到空串。
package extract

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/ledongthuc/pdf"
)

const MaxBytes = 20 << 20 // 与上传上限对齐

func KindFromFilename(name string) (kind string, ok bool) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".txt", ".md", ".markdown":
		return "text", true
	case ".pdf":
		return "pdf", true
	case ".docx":
		return "docx", true
	default:
		return "", false
	}
}

func Text(kind string, data []byte) (string, error) {
	switch kind {
	case "text":
		return strings.TrimSpace(string(data)), nil
	case "docx":
		return docxText(data)
	case "pdf":
		return pdfText(data)
	default:
		return "", fmt.Errorf("extract: unsupported kind %s", kind)
	}
}

func docxText(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("extract: docx: %w", err)
	}
	var raw []byte
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		raw, err = io.ReadAll(io.LimitReader(rc, MaxBytes))
		rc.Close()
		if err != nil {
			return "", err
		}
		break
	}
	if len(raw) == 0 {
		return "", fmt.Errorf("extract: docx missing word/document.xml")
	}
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var b strings.Builder
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "p" || t.Name.Local == "br" || t.Name.Local == "tab" {
				b.WriteByte('\n')
			}
		case xml.CharData:
			b.Write(t)
		}
	}
	return strings.TrimSpace(collapseSpace(b.String())), nil
}

func pdfText(data []byte) (string, error) {
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("extract: pdf: %w", err)
	}
	var b strings.Builder
	n := r.NumPage()
	for i := 1; i <= n; i++ {
		p := r.Page(i)
		if p.V.IsNull() {
			continue
		}
		txt, err := p.GetPlainText(nil)
		if err != nil {
			continue
		}
		b.WriteString(txt)
		b.WriteByte('\n')
	}
	return strings.TrimSpace(collapseSpace(b.String())), nil
}

func collapseSpace(s string) string {
	var b strings.Builder
	nl := false
	for _, r := range s {
		if r == '\n' || r == '\r' {
			if !nl {
				b.WriteByte('\n')
				nl = true
			}
			continue
		}
		if unicode.IsSpace(r) {
			if b.Len() > 0 && !nl {
				b.WriteByte(' ')
			}
			continue
		}
		nl = false
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}
