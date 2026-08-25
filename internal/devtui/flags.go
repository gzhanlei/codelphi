package devtui

import (
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

type Flags struct {
	Base        string
	Token       string
	OrgID       string
	Title       string
	Textbook    string
	Note        string
	Until       string
	Package     string
	Lesson      string
	Critique    string
	RebuildKind string
	Confirm     bool
	Help        bool
}

func ParseFlags(args []string) (Flags, error) {
	f := Flags{
		Base:  "http://127.0.0.1:8080",
		Token: "dev",
		OrgID: SeedOrgID,
		Title: "本地联调",
	}
	fs := flag.NewFlagSet("devtui", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&f.Base, "base", f.Base, "gateway 地址")
	fs.StringVar(&f.Token, "token", f.Token, "Bearer token（本地 dev）")
	fs.StringVar(&f.OrgID, "org", f.OrgID, "X-Org-Id")
	fs.StringVar(&f.Title, "title", f.Title, "课程/课名")
	fs.StringVar(&f.Textbook, "textbook", "", "课文路径 pdf/docx/md/txt")
	fs.StringVar(&f.Note, "note", "", "submit note")
	fs.StringVar(&f.Until, "until", "", "confirm|ready")
	fs.StringVar(&f.Package, "package", "", "已有 package id")
	fs.StringVar(&f.Lesson, "lesson", "", "lesson job id")
	fs.StringVar(&f.Critique, "critique", "", "rebuild 意见")
	fs.StringVar(&f.RebuildKind, "rebuild-kind", "", "plan|ppt")
	fs.BoolVar(&f.Confirm, "confirm", false, "POST /v1/lessons/{id}/confirm")
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			f.Help = true
			return f, nil
		}
		return f, err
	}
	f.Until = strings.TrimSpace(f.Until)
	if f.Until != "" && f.Until != "confirm" && f.Until != "ready" {
		return f, fmt.Errorf("-until 须为 confirm 或 ready")
	}
	return f, nil
}

// KindFromFilename 与 extract.KindFromFilename 对齐，避免 cmd 拉 pdf 解析器。
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
