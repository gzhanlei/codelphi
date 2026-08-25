package preset

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestLookupDigitalLesson(t *testing.T) {
	p, err := Lookup(DigitalLesson)
	if err != nil {
		t.Fatal(err)
	}
	if p.Copy.SubmitCTA == "" || p.Copy.CreateCTA == "" || p.Copy.LessonCTA == "" {
		t.Fatal("digital_lesson copy incomplete")
	}
	if len(p.Steps) == 0 || len(p.Artifacts) == 0 {
		t.Fatal("digital_lesson topology empty")
	}
}

func TestLookupUnknown(t *testing.T) {
	if _, err := Lookup("pr_campaign"); err == nil {
		t.Fatal("want error for unknown preset")
	}
}

func TestDigitalLessonCatalogConsistent(t *testing.T) {
	p, err := Lookup(DigitalLesson)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestDigitalLessonP0PrimeTopology(t *testing.T) {
	p, err := Lookup(DigitalLesson)
	if err != nil {
		t.Fatal(err)
	}
	if p.Copy.SubmitCTA != "做课件" {
		t.Fatalf("SubmitCTA = %q, want 做课件", p.Copy.SubmitCTA)
	}
	if got := p.Artifacts; len(got) != 3 || got[0] != "outline" || got[1] != "ppt" || got[2] != "script" {
		t.Fatalf("Artifacts = %v, want [outline ppt script]", got)
	}
	if p.Copy.ArtifactLabels["outline"] != "课件大纲" || p.Copy.ArtifactLabels["ppt"] == "" || p.Copy.ArtifactLabels["script"] == "" {
		t.Fatalf("labels = %v", p.Copy.ArtifactLabels)
	}
	if p.Copy.ArtifactLabels["plan"] != "教案" {
		t.Fatalf("plan label = %q, want 教案", p.Copy.ArtifactLabels["plan"])
	}
	for _, k := range p.Artifacts {
		if k == "plan" {
			t.Fatal("plan must not be a required artifact")
		}
	}
	if len(p.Steps) != 1 {
		t.Fatalf("Steps = %d, want 1 (材料 → 做片，无 design/确认门)", len(p.Steps))
	}
	s := p.Steps[0]
	if s.Capability != "ppt" || s.Platform != "pptcreator" || s.GateAfter {
		t.Fatalf("step = %+v, want ppt/pptcreator GateAfter=false", s)
	}
	if len(s.Emits) != 3 || s.Emits[0] != "ppt" || s.Emits[1] != "script" || s.Emits[2] != "outline" {
		t.Fatalf("emits = %v", s.Emits)
	}
}

func TestEntitledNilMeansDigitalLesson(t *testing.T) {
	got := Entitled(nil)
	if len(got) != 1 || got[0] != DigitalLesson {
		t.Fatalf("got %v", got)
	}
}

func TestEntitledEmptyArrayMeansDigitalLesson(t *testing.T) {
	got := Entitled(json.RawMessage("[]"))
	if len(got) != 1 || got[0] != DigitalLesson {
		t.Fatalf("got %v", got)
	}
}

func TestEntitledListsIDs(t *testing.T) {
	got := Entitled(json.RawMessage(`["digital_lesson","pr_campaign"]`))
	if len(got) != 2 || got[0] != DigitalLesson || got[1] != "pr_campaign" {
		t.Fatalf("got %v", got)
	}
}

func TestResolveCreateSingleOmits(t *testing.T) {
	id, err := ResolveCreate("", []string{DigitalLesson})
	if err != nil || id != DigitalLesson {
		t.Fatalf("id=%s err=%v", id, err)
	}
}

func TestResolveCreateMultiUnspecified(t *testing.T) {
	_, err := ResolveCreate("", []string{DigitalLesson, "pr_campaign"})
	if !errors.Is(err, ErrUnspecified) {
		t.Fatalf("err=%v", err)
	}
}

func TestResolveCreateForbidden(t *testing.T) {
	_, err := ResolveCreate("pr_campaign", []string{DigitalLesson})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err=%v", err)
	}
}

func TestResolveCreateExplicitOK(t *testing.T) {
	id, err := ResolveCreate(DigitalLesson, []string{DigitalLesson, "pr_campaign"})
	if err != nil || id != DigitalLesson {
		t.Fatalf("id=%s err=%v", id, err)
	}
}
