package preset

var catalog = map[string]Preset{
	DigitalLesson: {
		ID: DigitalLesson,
		Copy: Copy{
			ListTitle:   "我的项目",
			ListHint:    "一个项目一份材料、一套产物。当前套件是数字课。",
			CreateCTA:   "新建数字课",
			CreateTitle: "新建数字课",
			TitleLabel:  "项目名",
			TitleHint:   "例如：高等数学 · 第 3 章 导数",
			SubmitCTA:   "做课",
			ConfirmCTA:  "通过，继续",
			ConfirmHint: "设计与大纲已出。看过之后点「通过，继续」，才会生成 PPT 和讲稿。等待期间不扣配额。",
			EmptyList:   "还没有项目。点右上角建第一个。",
			ArtifactLabels: map[string]string{
				"design":  "课程设计",
				"outline": "教学大纲",
				"ppt":     "PPT",
				"script":  "讲稿",
			},
		},
		Artifacts: []string{"design", "outline", "ppt", "script"},
		Steps: []Step{
			{Capability: "design", Platform: "llm", Emits: []string{"design"}},
			{Capability: "outline", Platform: "llm", GateAfter: true, Emits: []string{"outline"}},
			{Capability: "ppt", Platform: "pptcreator", Emits: []string{"ppt", "script"}},
		},
	},
}
